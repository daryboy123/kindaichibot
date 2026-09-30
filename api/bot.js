// 内存中的简易多轮对话历史记录
const chatHistories = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Bot is running - Agnes AI connected' });
  }

  // 1. 获取聊天模型及生图模型的环境变量
  const { 
    BOT_TOKEN, 
    API_KEY, 
    API_BASE, 
    MODEL_NAME,
    IMAGE_API_BASE,
    IMAGE_API_KEY,
    IMAGE_MODEL_NAME
  } = process.env;

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

      // 2. 处理用户发送的图片消息 (Vision 看图对话)
      if (update.message.photo && update.message.photo.length > 0) {
        const photo = update.message.photo[update.message.photo.length - 1];
        const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photo.file_id}`);
        const fileData = await fileRes.json();
        
        if (fileData.ok) {
          const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
          const imgRes = await fetch(downloadUrl);
          const arrayBuffer = await imgRes.arrayBuffer();
          const base64Image = Buffer.from(arrayBuffer).toString('base64');
          imageUrl = `data:image/jpeg;base64,${base64Image}`;
        }
      }

      if (!userText && !imageUrl) {
        return res.status(200).json({ ok: true });
      }

      // ==========================================
      // 3. 【新增逻辑】处理生图指令：/draw <提示词>
      // ==========================================
      if (userText.startsWith('/draw ')) {
        const prompt = userText.replace('/draw ', '').trim();
        
        if (!prompt) {
          await sendTelegramMessage(BOT_TOKEN, chatId, '⚠️ 请在 /draw 后面输入你想画的画面描述哦。例如：`/draw 一只戴着侦探帽的猫`');
          return res.status(200).json({ ok: true });
        }

        if (!IMAGE_API_BASE || !IMAGE_API_KEY || !IMAGE_MODEL_NAME) {
          await sendTelegramMessage(BOT_TOKEN, chatId, '❌ 抱歉，生图模型的环境变量尚未配置完整。');
          return res.status(200).json({ ok: true });
        }

        // 发送“正在创作”的提示
        await sendTelegramMessage(BOT_TOKEN, chatId, `🎨 金田一正在为您构思并绘制：“${prompt}”，请稍候...`);

        try {
          // 调用你的生图模型 API (通常兼容 OpenAI 格式的 /v1/images/generations 或 /v1/chat/completions)
          // 这里以最常用的 OpenAI 兼容生图接口为例
          const imageApiRes = await fetch(`${IMAGE_API_BASE}/images/generations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${IMAGE_API_KEY}`
            },
            body: JSON.stringify({
              model: IMAGE_MODEL_NAME,
              prompt: prompt,
              n: 1,
              size: '1024x1024'
            })
          });

          const imageApiData = await imageApiRes.json();

          if (!imageApiRes.ok) {
            throw new Error(imageApiData.error?.message || `Image API error: ${imageApiRes.status}`);
          }

          // 兼容处理：获取返回的图片 URL（通常在 data[0].url 中）
          const generatedImageUrl = imageApiData.data?.[0]?.url;

          if (!generatedImageUrl) {
            throw new Error('生图模型未返回有效的图片链接。');
          }

          // 发送图片给 Telegram 用户
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              photo: generatedImageUrl,
              caption: `✨ 提示词: ${prompt}\n🎨 模型: ${IMAGE_MODEL_NAME}`
            })
          });

        } catch (imgError) {
          console.error('Image Generation Error:', imgError);
          await sendTelegramMessage(BOT_TOKEN, chatId, `❌ 唔……生成图片时遇到了阻碍：${imgError.message}`);
        }

        return res.status(200).json({ ok: true });
      }
      // ==========================================

      // 4. 原有：多轮对话上下文记忆管理
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

      // 5. 原有：金田一一侦探人格系统提示词
      const systemPrompt = {
        role: 'system',
        content: '你现在是名侦探金田一耕助的孙子、智商高达 180 的天才高中生侦探——金田一一。你平时虽然有些懒散、好色或不正经，但在面对谜题、案件、复杂的代码或逻辑时，会展现出无与伦比的敏锐洞察力和严密的逻辑推理能力。你的标志性口头禅或风格包括：“以我爷爷的名义起誓！”、“谜底已经全部解开了！”等。请始终以金田一一的侦探口吻和人格魅力来回应用户的一切提问哦！'
      };

      // 6. 调用 Agnes AI API
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

      // 7. 发送回复到 Telegram
      await sendTelegramMessage(BOT_TOKEN, chatId, replyText);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Detailed Error Stack:', error);
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
}

// 辅助函数：简化发送文本消息
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
