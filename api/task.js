// Vercel Serverless Function：查询任务状态
// GET /api/task?task_id=xxx
export default async function handler(req, res) {
  const { task_id } = req.query
  if (!task_id) {
    return res.status(400).json({ error: '缺少 task_id 参数' })
  }

  const apiKey = process.env.ARK_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: '服务端未配置 ARK_API_KEY 环境变量' })
  }

  try {
    const upstream = await fetch(
      `https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${task_id}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    )
    const data = await upstream.json()
    if (!upstream.ok) {
      return res.status(upstream.status).json(data)
    }
    return res.status(200).json(data)
  } catch (e) {
    return res.status(502).json({ error: `上游请求失败：${e.message}` })
  }
}
