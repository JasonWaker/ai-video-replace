// Vercel Serverless Function：代理可灵 Kling 创建视频任务
// POST /api/kling/generate
// Body: { mode: 'text'|'image', prompt, image_url, model_name, duration, aspect_ratio, negative_prompt? }
const KLING_BASE = 'https://api-beijing.klingai.com'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只支持 POST' })
  }

  const apiKey = process.env.KLING_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: '服务端未配置 KLING_API_KEY 环境变量' })
  }

  const {
    mode = 'text',
    prompt = '',
    image_url,
    model_name = 'kling-v2-5-turbo',
    duration = 5,
    aspect_ratio = '16:9',
    negative_prompt = '',
  } = req.body || {}

  if (mode === 'text' && !prompt.trim()) {
    return res.status(400).json({ error: '缺少 prompt 参数' })
  }
  if (mode === 'image' && !image_url) {
    return res.status(400).json({ error: '图生视频缺少 image_url 参数' })
  }

  const path = mode === 'image' ? '/v1/videos/image2video' : '/v1/videos/text2video'
  const payload = {
    model_name,
    prompt,
    duration: String(duration),
    aspect_ratio,
  }
  if (mode === 'image') payload.image_url = image_url
  if (negative_prompt) payload.negative_prompt = negative_prompt

  try {
    const upstream = await fetch(`${KLING_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    })

    const data = await upstream.json()
    if (!upstream.ok || data.code !== 0) {
      return res.status(upstream.ok ? 400 : upstream.status).json({
        error: data.message || `可灵返回错误 code=${data.code}`,
      })
    }
    return res.status(200).json({ task_id: data.data.task_id })
  } catch (e) {
    return res.status(502).json({ error: `上游请求失败：${e.message}` })
  }
}
