// Vercel Serverless Function：Seedream 4.0 文生图（用于生成 AI 人物参考图，供图生视频使用）
// POST /api/seedream  Body: { prompt: string, size?: string }
// 返回：{ image_url: "https://..." }
import { sanitizePrompt } from './_sanitize.js'

const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
const SEEDREAM_MODEL = process.env.SEEDREAM_MODEL || 'doubao-seedream-4-0-20260415'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只支持 POST' })
  }

  const apiKey = process.env.ARK_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: '服务端未配置 ARK_API_KEY 环境变量' })
  }

  const { prompt, size = '1080x1920' } = req.body || {}
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: '缺少 prompt 参数' })
  }

  const safePrompt = sanitizePrompt(prompt)

  try {
    const upstream = fetch(`${ARK_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: SEEDREAM_MODEL,
        prompt: safePrompt,
        size,
        response_format: 'url',
        watermark: false,
      }),
    })
    // 超时 60s
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('生成超时(60s)')), 60000))
    const resp = await Promise.race([upstream, timer])
    const data = await resp.json()

    if (!resp.ok) {
      const errObj = data?.error
      const msg = typeof errObj === 'string' ? errObj : errObj?.message || JSON.stringify(data)
      return res.status(resp.status).json({ error: msg })
    }

    const url = data?.data?.[0]?.url
    if (!url) {
      return res.status(502).json({ error: 'Seedream 未返回图片 URL', raw: JSON.stringify(data).slice(0, 500) })
    }
    return res.status(200).json({ image_url: url, prompt: safePrompt })
  } catch (e) {
    return res.status(502).json({ error: `上游请求失败：${e.message}` })
  }
}
