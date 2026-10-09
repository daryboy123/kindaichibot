// 内存中的简易多轮对话历史记录
const chatHistories = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Bot is running - Agnes AI connected' });
  }

  const { BOT_TOKEN, API_KEY, API_BASE, MODEL_NAME } = process.env;

  // 严格对齐官方文档的根路径
  const IMAGE_API_BASE = 'https://apihub.agnes-ai.com/v1';
  const IMAGE_API_KEY = 'sk-ozDsndDe9QaPCRibCGCpsx671obGruY9KBCThyWk8KvRPYBs';
  const IMAGE_MODEL_NAME = 'agnes-image-2.5-flash';

  if (!BOT_TOKEN || !API_KEY || !API_BASE || !MODEL_NAME) {
    console.error('Missing required chat environment variables.');
    return res.status(500).json({ error: 'Missing environment variables.' });
  }

  try {
    const update = req.body;
    
    if (update && update.message) {
      const chatId = update.message.chat.id;
      let userText = update.message.text || update.message.caption || '';
      let imageUrl = null;

      // 1. 处理用户发送或回复的图片
      let targetPhoto = null;
      if (update.message.photo && update.message.photo.length > 0) {
        targetPhoto = update.message.photo[update.message.photo.length - 1];
      } else if (update.message.reply_to_message && update.message.reply_to_message.photo) {
        const photos = update.message.reply_to_message.photo;
        targetPhoto = photos[photos.length - 1];
      }

      if (targetPhoto) {
        const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${targetPhoto.file_id}`);
        const fileData = await fileRes.json();
        
        if (fileData.ok) {
          const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
          const imgRes = await fetch(downloadUrl);
          const arrayBuffer = await imgRes.arrayBuffer();
          const base64Image = Buffer.from(arrayBuffer).toString('base64');
          imageUrl = `data:image/jpeg;base64,${base64Image}`;
        }
      }

      // 辅助函数：从文本中提取并移除尺寸后缀（支持 1k, 2k, 3k, 4k，不区分大小写）
      function parseSizeAndPrompt(text, prefix) {
        let cleanText = text.replace(prefix, '').trim();
        let size = undefined;
        
        // 匹配结尾或带空格的 1k, 2k, 3k, 4k
        const sizeMatch = cleanText.match(/\b(1k|2k|3k|4k)\b/i);
        if (sizeMatch) {
          size = sizeMatch[1].toLowerCase();
          cleanText = cleanText.replace(sizeMatch[0], '').trim();
        }
        return { prompt: cleanText, size };
      }

      // ==========================================
      // 2. 处理图生图功能 (使用标准 /v1/images/generations)
      // ==========================================
      if (imageUrl && (userText.startsWith('/img2img') || userText.startsWith('/draw') || userText.length > 0)) {
        const parsed = parseSizeAndPrompt(userText, userText.startsWith('/img2img') ? '/img2img' : '/draw');
        const prompt = parsed.prompt || 'Based on this image, generate a new artistic variation.';
        const requestedSize = parsed.size; // 1k, 2k, 3k, 4k 或 undefined
        
        await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 金田一正在参考这张图片为您进行图生图创作${requestedSize ? ` [${requestedSize.toUpperCase()}]` :''}：“${prompt}”, 请稍候...`);

        try {
          const requestBody = {
            model: IMAGE_MODEL_NAME,
            prompt: prompt,
            image: imageUrl,
            n: 1,
            response_format: 'url'
          };
          if (requestedSize) {
            requestBody.size = requestedSize;
          }

          const imageApiRes = await fetch(`${IMAGE_API_BASE}/images/generations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${IMAGE_API_KEY}`
            },
            body: JSON.stringify(requestBody)
          });

          const imageApiData = await imageApiRes.json();
          
          if (!imageApiRes.ok) {
            throw new Error(imageApiData.error?.message || `API error: ${imageApiRes.status}`);
          }

          const finalImageUrl = imageApiData.data?.[0]?.url || imageApiData.data?.[0]?.b64_json || imageApiData.url;

          if (!finalImageUrl) {
            throw new Error(`生图接口未返回有效图片地址`);
          }

          // 拼接带原图 PNG 链接的文案
          const captionText = `✨ 图生图提示词: ${prompt}${requestedSize ? ` (${requestedSize.toUpperCase()})` : ''}\n\n🔗 原图 PNG 链接: ${finalImageUrl}`;

          if (finalImageUrl.startsWith('data:image')) {
            const matches = finalImageUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
            if (!matches) {
              throw new Error('解析 Base64 图片数据失败');
            }
            const ext = matches[1];
            const buffer = Buffer.from(matches[2], 'base64');

            await sendTelegramPhotoBuffer(BOT_TOKEN, chatId, buffer, captionText, `image.${ext === 'jpeg' ? 'jpg' : ext}`);
          } else {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                photo: finalImageUrl,
                caption: captionText
              })
            });
          }

        } catch (imgError) {
          console.error('Image-to-Image Error:', imgError);
          await sendTelegramMessage(BOT_TOKEN, chatId, `❌ 唔……图生图时遇到了阻碍：${imgError.message}`);
        }

        return res.status(200).json({ ok: true });
      }

      // ==========================================
      // 3. 处理纯文生图指令：/draw <提示词> [1k/2k/3k/4k]
      // ==========================================
      if (userText.startsWith('/draw ')) {
        const parsed = parseSizeAndPrompt(userText, '/draw');
        const prompt = parsed.prompt;
        const requestedSize = parsed.size; // 1k, 2k, 3k, 4k 或 undefined
        
        if (!prompt) {
          await sendTelegramMessage(BOT_TOKEN, chatId, '⚠️ 请在 /draw 后面输入你想画的画面描述哦（例如：/draw 一只猫 2k）。');
          return res.status(200).json({ ok: true });
        }

        await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 金田一正在为您构思并绘制${requestedSize ? ` [${requestedSize.toUpperCase()}]` :''}：“${prompt}”, 请稍候...`);

        try {
          const requestBody = {
            model: IMAGE_MODEL_NAME,
            prompt: prompt,
            n: 1,
            response_format: 'url'
          };
          if (requestedSize) {
            requestBody.size = requestedSize;
          }

          const imageApiRes = await fetch(`${IMAGE_API_BASE}/images/generations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${IMAGE_API_KEY}`
            },
            body: JSON.stringify(requestBody)
          });

          const imageApiData = await imageApiRes.json();

          if (!imageApiRes.ok) {
            throw new Error(imageApiData.error?.message || `API error: ${imageApiRes.status}`);
          }

          const finalImageUrl = imageApiData.data?.[0]?.url || imageApiData.data?.[0]?.b64_json || imageApiData.url;

          if (!finalImageUrl) {
            throw new Error(`生图接口未返回有效图片`);
          }

          // 拼接带原图 PNG 链接的文案
          const captionText = `✨ 提示词: ${prompt}${requestedSize ? ` (${requestedSize.toUpperCase()})` : ''}\n\n🔗 原图 PNG 链接: ${finalImageUrl}`;

          if (finalImageUrl.startsWith('data:image')) {
            const matches = finalImageUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
            if (!matches) {
              throw new Error('解析 Base64 图片数据失败');
            }
            const ext = matches[1];
            const buffer = Buffer.from(matches[2], 'base64');

            await sendTelegramPhotoBuffer(BOT_TOKEN, chatId, buffer, captionText, `image.${ext === 'jpeg' ? 'jpg' : ext}`);
          } else {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                photo: finalImageUrl,
                caption: captionText
              })
            });
          }

        } catch (imgError) {
          console.error('Image Generation Error:', imgError);
          await sendTelegramMessage(BOT_TOKEN, chatId, `❌ 唔……生成图片时遇到了阻碍：${imgError.message}`);
        }

        return res.status(200).json({ ok: true });
      }

      // ==========================================
      // 4. 常规多轮文字聊天 / 看图说话
      // ==========================================
      if (!chatHistories.has(chatId)) {
        chatHistories.set(chatId, []);
      }
      const history = chatHistories.get(chatId);

      let userMessageContent;
      if (imageUrl) {
        userMessageContent = [
          { type: 'text', text: userText || '请帮我看看这张现场照片或图片里有什么线索。' },
          { type: 'image_url', image_url: { url: imageUrl } }
        ];
      } else {
        userMessageContent = userText;
      }

      history.push({ role: 'user', content: userMessageContent });

      if (history.length > 10) {
        history.splice(0, history.length - 10);
      }

      // 已精简的系统提示词：不废话、不吵闹、冷淡干练
      const systemPrompt = {
        role: 'system',
        content: '你是金田一一。性格懒散、寡言、极其怕麻烦。说话简短冷淡，不使用夸张的感叹号或口头禅，直奔核心。在面对谜题或代码时只给出最直接的结论或最精炼的逻辑，绝不多说废话[cite: 1]。'
      };

      const aiResponse = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: [systemPrompt, ...history]
        })
      });

      const aiData = await aiResponse.json();
      
      if (!aiResponse.ok) {
        console.error('Agnes AI Error Response:', aiData);
        throw new Error(aiData.error?.message || `Agnes AI API error: ${aiResponse.status}`);
      }

      const replyText = aiData.choices?.[0]?.message?.content || '……没别的事的话，我先睡了。';

      history.push({ role: 'assistant', content: replyText });

      await sendTelegramMessage(BOT_TOKEN, chatId, replyText);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Detailed Error Stack:', error);
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
}

async function sendTelegramMessage(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

async function sendTelegramPhotoBuffer(botToken, chatId, buffer, caption, filename) {
  const boundary = '----TelegramFormBoundary' + Math.random().toString(36).substring(2);
  
  let bodyParts = [];
  bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));
  if (caption) {
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
  }
  bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/png\r\n`));
  bodyParts.push(buffer);
  bodyParts.push(Buffer.from(`--${boundary}--\r\n`));

  const payload = Buffer.concat(bodyParts);

  await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: payload
  });
}
