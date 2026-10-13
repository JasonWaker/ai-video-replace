// Vercel Serverless Function：视频要素分析（视觉大模型）
// POST /api/analyze  Body: { frames: [dataURL, ...] }  （前端抽帧后的关键帧图，≤6张）
// 返回结构化分析：人物外观 / 场景 / 动作节奏 / 镜头 / BGM 提示
const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
const ANALYZE_MODEL = process.env.ANALYZE_MODEL || 'doubao-seed-2-1-pro-260628'

const PROMPT = `你是视频分析专家。这些是同一段视频按时间顺序抽取的关键帧。请分析视频并只输出一个 JSON 对象（不要 markdown 代码块），字段如下：
{
  "person": "主要人物的外观描述：性别、年龄段、发型发色、五官特征、服装类型与颜色、配饰。重要：这段描述会被直接用于 AI 文生图模型重新生成该人物，必须使用通过图片内容审核的中性表达——只描述发型、脸型、五官、服装类型和颜色（如「白色短袖上衣」「黑色百褶短裙」），不要描述身材曲线、体型细节、着装暴露程度或任何敏感特征",
  "scene": "场景描述：地点、环境、背景、光线、色调、氛围",
  "motion": "人物动作与节奏描述：在做什么（如舞蹈类型、卡点动作）、动作幅度、与节拍的关系、起始到结束的关键动作变化",
  "camera": "镜头语言：景别（全身/半身/特写）、机位运动（固定/环绕/跟随）、转场方式",
  "bgm_hint": "根据画面节奏推测的BGM风格（如：动感电子、流行舞曲、慢摇），仅推测风格不猜歌名",
  "frame_count": 帧中出现的不同镜头/画面数量(数字)
}`

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只支持 POST' })
  }

  const apiKey = process.env.ARK_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: '服务端未配置 ARK_API_KEY 环境变量' })
  }

  const { frames, model } = req.body || {}
  const useModel = model || process.env.ANALYZE_MODEL || ANALYZE_MODEL
  if (!Array.isArray(frames) || frames.length === 0) {
    return res.status(400).json({ error: '缺少 frames 参数（关键帧图片数组）' })
  }
  if (frames.length > 8) {
    return res.status(400).json({ error: '帧数过多，最多 8 张' })
  }

  const content = [{ type: 'text', text: PROMPT }]
  for (const f of frames) {
    content.push({ type: 'image_url', image_url: { url: f } })
  }

  try {
    const upstream = await fetch(`${ARK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: useModel,
        messages: [{ role: 'user', content }],
        thinking: { type: 'disabled' }, // 关闭深度思考：分析任务无需推理链，响应更快更省
      }),
    })

    const data = await upstream.json()
    if (!upstream.ok) {
      const msg = data?.error?.message || `视觉模型返回 ${upstream.status}`
      return res.status(upstream.status).json({ error: msg })
    }

    const text = data?.choices?.[0]?.message?.content || ''
    // 提取 JSON（容忍模型输出 markdown 包裹）
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) {
      return res.status(500).json({ error: '模型未返回有效 JSON', raw: text.slice(0, 500) })
    }
    try {
      return res.status(200).json({ analysis: JSON.parse(m[0]) })
    } catch {
      return res.status(500).json({ error: 'JSON 解析失败', raw: text.slice(0, 500) })
    }
  } catch (e) {
    return res.status(502).json({ error: `上游请求失败：${e.message}` })
  }
}
