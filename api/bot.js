// 内存中的简易多轮对话历史记录
const chatHistories = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Bot is running - Agnes AI connected' });
  }

  const { BOT_TOKEN, API_KEY, API_BASE, MODEL_NAME } = process.env;

  const IMAGE_API_BASE = 'https://apinebula.ai/v1';
  const IMAGE_API_KEY = 'sk-fT5ZfTiQ5wVV5Gm9t2ridRh8yFbFFsBOQY9keyfNIrWni0UT';
  const IMAGE_MODEL_NAME = 'gemini-2.5-flash-image';

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

      // ==========================================
      // 2. 处理图生图功能：当用户带图发送，或者回复图并输入指令时
      // ==========================================
      if (imageUrl && (userText.startsWith('/img2img') || userText.startsWith('/draw') || userText.length > 0)) {
        const prompt = userText.replace('/img2img', '').replace('/draw', '').trim() || 'Based on this image, generate a new artistic variation.';
        
        await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 金田一正在参考这张图片为您进行图生图创作：“${prompt}”，请稍候...`);

        try {
          // 通过 chat/completions 传入图文，要求模型根据参考图生成新图
          const imageApiRes = await fetch(`${IMAGE_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${IMAGE_API_KEY}`
            },
            body: JSON.stringify({
              model: IMAGE_MODEL_NAME,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: `Generate a new image based on this reference image and prompt: ${prompt}` },
                    { type: 'image_url', image_url: { url: imageUrl } }
                  ]
                }
              ]
            })
          });

          const imageApiData = await imageApiRes.json();
          
          if (!imageApiRes.ok) {
            throw new Error(imageApiData.error?.message || `API error: ${imageApiRes.status}`);
          }

          const replyContent = imageApiData.choices?.[0]?.message?.content || '';
          
          let finalImageUrl = null;
          const markdownImgMatch = replyContent.match(/\((https?:\/\/[^\s)]+)\)/);
          const rawUrlMatch = replyContent.match(/(https?:\/\/[^\s]+\.(png|jpg|jpeg|webp))/i);

          if (markdownImgMatch) {
            finalImageUrl = markdownImgMatch[1];
          } else if (rawUrlMatch) {
            finalImageUrl = rawUrlMatch[0];
          } else if (replyContent.startsWith('http')) {
            finalImageUrl = replyContent.trim();
          }

          if (!finalImageUrl) {
            throw new Error(`模型未返回图片链接，回复内容为: ${replyContent.slice(0, 100)}`);
          }

          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              photo: finalImageUrl,
              caption: `✨ 图生图提示词: ${prompt}`
            })
          });

        } catch (imgError) {
          console.error('Image-to-Image Error:', imgError);
          await sendTelegramMessage(BOT_TOKEN, chatId, `❌ 唔……图生图时遇到了阻碍：${imgError.message}`);
        }

        return res.status(200).json({ ok: true });
      }

      // ==========================================
      // 3. 处理纯文生图指令：/draw <提示词>
      // ==========================================
      if (userText.startsWith('/draw ')) {
        const prompt = userText.replace('/draw ', '').trim();
        
        if (!prompt) {
          await sendTelegramMessage(BOT_TOKEN, chatId, '⚠️ 请在 /draw 后面输入你想画的画面描述哦。');
          return res.status(200).json({ ok: true });
        }

        await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 金田一正在为您构思并绘制：“${prompt}”，请稍候...`);

        try {
          const imageApiRes = await fetch(`${IMAGE_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${IMAGE_API_KEY}`
            },
            body: JSON.stringify({
              model: IMAGE_MODEL_NAME,
              messages: [
                { role: 'user', content: `Generate an image: ${prompt}` }
              ]
            })
          });

          const imageApiData = await imageApiRes.json();

          if (!imageApiRes.ok) {
            throw new Error(imageApiData.error?.message || `API error: ${imageApiRes.status}`);
          }

          const replyContent = imageApiData.choices?.[0]?.message?.content || '';
          
          let finalImageUrl = null;
          const markdownImgMatch = replyContent.match(/\((https?:\/\/[^\s)]+)\)/);
          const rawUrlMatch = replyContent.match(/(https?:\/\/[^\s]+\.(png|jpg|jpeg|webp))/i);

          if (markdownImgMatch) {
            finalImageUrl = markdownImgMatch[1];
          } else if (rawUrlMatch) {
            finalImageUrl = rawUrlMatch[0];
          } else if (replyContent.startsWith('http')) {
            finalImageUrl = replyContent.trim();
          }

          if (!finalImageUrl) {
            throw new Error(`模型未直接返回图片链接，文字回复为: ${replyContent.slice(0, 100)}`);
          }

          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              photo: finalImageUrl,
              caption: `✨ 提示词: ${prompt}`
            })
          });

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

      const systemPrompt = {
        role: 'system',
        content: '你现在是名侦探金田一耕助的孙子、智商高达 180 的天才高中生侦探——金田一一。你平时虽然有些懒散、好色或不正经，但在面对谜题、案件、复杂的代码或逻辑时，会展现出无与伦比的敏锐洞察力和严密的逻辑推理能力。你的标志性口头禅或风格包括：“以我爷爷的名义起誓！”、“谜底已经全部解开了！”等。请始终以金田一一的侦探口吻和人格魅力来回应用户的一切提问哦！'
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

      const replyText = aiData.choices?.[0]?.message?.content || '唔……这个谜题有点棘手，目前还没有得出结论。';

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
