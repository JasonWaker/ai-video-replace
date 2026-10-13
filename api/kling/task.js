// Vercel Serverless Function：查询可灵任务状态（归一化输出，方便前端统一处理）
// GET /api/kling/task?task_id=xxx&mode=text|image
// 返回: { status: 'succeeded'|'failed'|'processing', video_url, raw_status, message }
const KLING_BASE = 'https://api-beijing.klingai.com'

export default async function handler(req, res) {
  const { task_id, mode = 'text' } = req.query
  if (!task_id) {
    return res.status(400).json({ error: '缺少 task_id 参数' })
  }

  const apiKey = process.env.KLING_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: '服务端未配置 KLING_API_KEY 环境变量' })
  }

  const path = mode === 'image' ? 'image2video' : 'text2video'

  try {
    const upstream = await fetch(`${KLING_BASE}/v1/videos/${path}/${task_id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const data = await upstream.json()

    if (!upstream.ok || data.code !== 0) {
      return res.status(upstream.ok ? 400 : upstream.status).json({
        error: data.message || `可灵返回错误 code=${data.code}`,
      })
    }

    const task = data.data || {}
    const raw = task.task_status // submitted | processing | succeed | failed

    let status = 'processing'
    if (raw === 'succeed') status = 'succeeded'
    else if (raw === 'failed') status = 'failed'

    let video_url = ''
    const videos = (task.task_result && task.task_result.videos) || []
    if (videos.length > 0) video_url = videos[0].url || ''

    return res.status(200).json({
      status,
      video_url,
      raw_status: raw,
      message: task.task_status_msg || '',
    })
  } catch (e) {
    return res.status(502).json({ error: `上游请求失败：${e.message}` })
  }
}
