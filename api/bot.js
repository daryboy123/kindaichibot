export default async function handler(req, res) {
  // 强制在 Vercel 日志中打印，只要 Telegram 请求到达，这里就一定会有日志！
  console.log("=== 收到来自 Telegram 的请求 ===");
  console.log("请求方法:", req.method);
  console.log("请求体:", JSON.stringify(req.body));

  const { BOT_TOKEN } = process.env;

  // 如果连 BOT_TOKEN 都没拿到，直接报错返回
  if (!BOT_TOKEN) {
    console.error("致命错误：环境变量中未找到 BOT_TOKEN");
    return res.status(500).json({ error: 'Missing BOT_TOKEN' });
  }

  try {
    const update = req.body;
    
    if (update && update.message) {
      const chatId = update.message.chat.id;
      const userText = update.message.text || '测试';

      console.log(`准备向聊天 ID: ${chatId} 发送回显测试消息...`);

      // 强行用 Telegram 接口回复一句固定的测试话语，绕过 AI 接口，看通不通！
      const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `[侦探系统联调中] 收到你的消息了："${userText}"。后端运行正常！`
        })
      });

      const tgData = await tgRes.json();
      console.log("Telegram 发送结果:", tgData);
    }

    return res.status(200).json({ ok: true, debug: "success" });
  } catch (error) {
    console.error("捕获到严重异常:", error);
    return res.status(500).json({ error: error.message });
  }
}
