// Vercel Serverless Function：代理火山方舟 Seedance 创建任务
// POST /api/generate
// Body: { model, duration, ratio, generate_audio, watermark, content: [{text,type},{image_url,type}] }
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只支持 POST' })
  }

  const apiKey = process.env.ARK_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: '服务端未配置 ARK_API_KEY 环境变量' })
  }

  const { model = 'doubao-seedance-2-5-260628', duration = 5, ratio = '16:9', generate_audio = true, watermark = false, content } = req.body || {}

  if (!content || !Array.isArray(content) || content.length === 0) {
    return res.status(400).json({ error: '缺少 content 参数' })
  }

  try {
    const upstream = await fetch('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, duration, ratio, generate_audio, watermark, content }),
    })

    const data = await upstream.json()
    if (!upstream.ok) {
      return res.status(upstream.status).json(data)
    }
    return res.status(200).json({ task_id: data.id })
  } catch (e) {
    return res.status(502).json({ error: `上游请求失败：${e.message}` })
  }
}
