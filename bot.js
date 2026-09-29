// 内存中的简易多轮对话历史记录（注：Serverless 环境下实例可能会热启动保留，可提供基础的短期上下文记忆）
const chatHistories = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Bot is running' });
  }

  const { BOT_TOKEN, API_KEY, API_BASE, MODEL_NAME } = process.env;

  if (!BOT_TOKEN || !API_KEY) {
    console.error('Missing BOT_TOKEN or API_KEY');
    return res.status(500).json({ error: 'Missing credentials.' });
  }

  const apiBase = API_BASE || 'https://apinebula.ai/v1';
  const modelName = MODEL_NAME || 'grok-4.6';

  try {
    const update = req.body;
    
    if (update && update.message) {
      const chatId = update.message.chat.id;
      let userText = update.message.text || update.message.caption || '';
      let imageUrl = null;

      // 1. 处理用户发送的图片消息 (Vision)
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

      // 2. 处理用户发送的文件/文档 (长文本与文件自动摘要解析)
      if (update.message.document) {
        const doc = update.message.document;
        const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${doc.file_id}`);
        const fileData = await fileRes.json();
        
        if (fileData.ok) {
          const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
          const docRes = await fetch(downloadUrl);
          const textContent = await docRes.text(); // 获取文本文件内容
          
          userText = `[用户上传了文件: ${doc.file_name}]\n文件内容如下：\n${textContent}\n\n用户附带说明：${userText || '请帮我仔细分析和解构这份文件的线索与核心内容~'}`;
        }
      }

      if (!userText && !imageUrl) {
        return res.status(200).json({ ok: true });
      }

      // 3. 管理上下文记忆 (Multi-turn Memory)
      if (!chatHistories.has(chatId)) {
        chatHistories.set(chatId, []);
      }
      const history = chatHistories.get(chatId);

      // 构造当前用户的消息内容
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

      // 限制历史记录长度，最多保留最近 10 条消息（5 轮对话），避免超出 Token 限制
      if (history.length > 10) {
        history.splice(0, history.length - 10);
      }

      // 4. 定义金田一一的系统提示词（含名侦探人设、推理风格、联网实时资讯指引）
      const systemPrompt = {
        role: 'system',
        content: '你现在是名侦探金田一耕助的孙子、智商高达 180 的天才高中生侦探——金田一一。你平时虽然有些懒散、好色或不正经，但在面对谜题、案件、复杂的代码或长文本逻辑时，会展现出无与伦比的敏锐洞察力和严密的逻辑推理能力。你的标志性口头禅或风格包括：“以我爷爷的名义起誓！”、“谜底已经全部解开了！”等。你可以利用你的实时资讯和联网搜索能力去剖析时事新闻、搜集线索。请始终以金田一一的侦探口吻和人格魅力来回应用户的一切提问哦！'
      };

      // 5. 调用 Grok (apinebula.ai) API
      const aiResponse = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: modelName,
          messages: [systemPrompt, ...history]
        })
      });

      const aiData = await aiResponse.json();
      const replyText = aiData.choices?.[0]?.message?.content || '唔……这个谜题有点棘手，目前还没有得出结论。';

      // 将 AI 的回复也存入历史记忆中
      history.push({ role: 'assistant', content: replyText });

      // 6. 将处理好的推理回复发送回 Telegram
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: replyText
        })
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Detailed Error Stack:', error);
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
}
