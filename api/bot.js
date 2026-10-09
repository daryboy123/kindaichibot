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

      // 尺寸比例与具体分辨率映射表（严格对照官方文档）
      const RESOLUTION_MAP = {
        '1:1': { '1k': '1024x1024', '2k': '2048x2048', '3k': '3072x3072', '4k': '4096x4096' },
        '3:4': { '1k': '864x1152',  '2k': '1728x2304', '3k': '2592x3456', '4k': '3456x4608' },
        '4:3': { '1k': '1152x864',  '2k': '2304x1728', '3k': '3456x2592', '4k': '4608x3456' },
        '16:9':{ '1k': '1312x736',  '2k': '2624x1472', '3k': '3936x2208', '4k': '5248x2944' },
        '9:16':{ '1k': '736x1312',  '2k': '1472x2624', '3k': '2208x3936', '4k': '2944x5248' },
        '2:3': { '1k': '832x1248',  '2k': '1664x2496', '3k': '2496x3744', '4k': '3328x4992' },
        '3:2': { '1k': '1248x832',  '2k': '2496x1664', '3k': '3744x2496', '4k': '4992x3328' },
        '21:9':{ '1k': '1568x672',  '2k': '3136x1344', '3k': '4704x2016', '4k': '6272x2688' }
      };

      // 辅助函数：从文本中提取比例、分辨率和净化提示词
      function parseParams(text, prefix) {
        let cleanText = text.replace(prefix, '').trim();
        let ratio = '1:1';     // 默认比例
        let tier = '1k';       // 默认档位

        // 1. 匹配比例 (支持 1:1, 3:4, 4:3, 16:9, 9:16, 2:3, 3:2, 21:9)
        const ratioMatch = cleanText.match(/\b(1:1|3:4|4:3|16:9|9:16|2:3|3:2|21:9)\b/i);
        if (ratioMatch) {
          ratio = ratioMatch[1];
          cleanText = cleanText.replace(ratioMatch[0], '').trim();
        }

        // 2. 匹配分辨率档位 (1k, 2k, 3k, 4k)
        const tierMatch = cleanText.match(/\b(1k|2k|3k|4k)\b/i);
        if (tierMatch) {
          tier = tierMatch[1].toLowerCase();
          cleanText = cleanText.replace(tierMatch[0], '').trim();
        }

        // 获取实际像素尺寸
        const exactSize = RESOLUTION_MAP[ratio]?.[tier] || '1024x1024';

        return { prompt: cleanText, ratio, tier, size: exactSize };
      }

      // ==========================================
      // 2. 处理图生图功能 (使用标准 /v1/images/generations)
      // ==========================================
      if (imageUrl && (userText.startsWith('/img2img') || userText.startsWith('/draw') || userText.length > 0)) {
        const parsed = parseParams(userText, userText.startsWith('/img2img') ? '/img2img' : '/draw');
        const prompt = parsed.prompt || 'Based on this image, generate a new artistic variation.';
        
        await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 金田一正在参考这张图片为您进行图生图创作 [比例: ${parsed.ratio}, 档位: ${parsed.tier.toUpperCase()}, 尺寸: ${parsed.size}]：“${prompt}”, 请稍候...`);

        try {
          const requestBody = {
            model: IMAGE_MODEL_NAME,
            prompt: prompt,
            image: imageUrl,
            size: parsed.size, // 写入具体的宽x高像素
            n: 1,
            response_format: 'url'
          };

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

          const captionText = `✨ 图生图提示词: ${prompt}\n📐 比例: ${parsed.ratio} | 规格: ${parsed.tier.toUpperCase()} (${parsed.size})\n\n🔗 原图 PNG 链接: ${finalImageUrl}`;

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
      // 3. 处理纯文生图指令：/draw <提示词> [比例] [分辨率]
      // ==========================================
      if (userText.startsWith('/draw ')) {
        const parsed = parseParams(userText, '/draw');
        const prompt = parsed.prompt;
        
        if (!prompt) {
          await sendTelegramMessage(BOT_TOKEN, chatId, '⚠️ 请在 /draw 后面输入你想画的画面描述哦（例如：/draw 赛博朋克 16:9 4k）。');
          return res.status(200).json({ ok: true });
        }

        await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 金田一正在为您构思并绘制 [比例: ${parsed.ratio}, 档位: ${parsed.tier.toUpperCase()}, 尺寸: ${parsed.size}]：“${prompt}”, 请稍候...`);

        try {
          const requestBody = {
            model: IMAGE_MODEL_NAME,
            prompt: prompt,
            size: parsed.size, // 写入具体的宽x高像素
            n: 1,
            response_format: 'url'
          };

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

          const captionText = `✨ 提示词: ${prompt}\n📐 比例: ${parsed.ratio} | 规格: ${parsed.tier.toUpperCase()} (${parsed.size})\n\n🔗 原图 PNG 链接: ${finalImageUrl}`;

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
