// Vercel Serverless Function：动作脚本直出 — 把视频拆解为按秒 keyframe 的动作时间轴
// POST /api/analyze-motion  Body: { frames: [dataURL, ...], duration: number }
// 返回：{ timeline: [{t, head, arm, waist, hip, eye, expression}], narrative, scene, camera }
// 设计目的：把真人画面转成纯文字动作脚本，避开真人肖像检测，再喂给 Seedance 图生视频。

const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
const ANALYZE_MODEL = process.env.ANALYZE_MODEL || 'doubao-seed-2-1-pro-260628'

const PROMPT = `你是舞蹈动作拆解师。这些是同一段视频按时间顺序抽取的关键帧（共 N 张，覆盖整段约 D 秒）。请把视频里人物的动作拆解成"按秒 keyframe 时间轴"，只输出一个 JSON 对象（不要 markdown 代码块）：

{
  "scene": "一句话场景描述：地点、光线、氛围（中性词，不评价人物身材）",
  "camera": "一句话镜头描述：固定/跟随/景别",
  "timeline": [
    {
      "t": 0.0,
      "head": "头部动作：正对镜头 / 转向左侧 / 回头看镜头 / 低头 等中性词",
      "arm": "手臂动作：自然下垂 / 右手撩发 / 双手举起 / 叉腰 等",
      "waist": "腰部动作：挺直 / 微侧 / 转动 等",
      "hip": "胯部动作：中立 / 轻摆 / 侧顶 等（避免描述性感/扭动幅度）",
      "eye": "视线方向：看镜头 / 看侧方 / 闭眼微笑",
      "expression": "表情：微笑 / 露齿笑 / 酷脸 / 惊讶"
    }
  ],
  "narrative": "一段 80 字以内的自然语言动作脚本，把上面时间轴串成连贯描述（用于直接喂给视频生成模型）"
}

硬要求：
1. timeline 按 1 秒 1 个 keyframe 输出，t 从 0.0 开始，到 D 秒结束（保留 1 位小数）。
2. 全部使用中性、动作导向的动词；禁止出现：性感、妩媚、诱惑、火辣、身材、曲线、翘臀、扭腰摆胯、湿身、暴露 等词。
3. 不评价人物长相、颜值、服装暴露程度；只描述"在做什么动作"。
4. 如果是多人跳舞，timeline 字段描述"两个人同步做 XX"，不要分别描述每个人。
5. narrative 段要直接可用作视频 prompt 的动作部分，开头写"两人随音乐鼓点同步："。`

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只支持 POST' })
  }

  const apiKey = process.env.ARK_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: '服务端未配置 ARK_API_KEY 环境变量' })
  }

  const { frames, duration = 10, model } = req.body || {}
  const useModel = model || ANALYZE_MODEL
  if (!Array.isArray(frames) || frames.length === 0) {
    return res.status(400).json({ error: '缺少 frames 参数' })
  }
  if (frames.length > 12) {
    return res.status(400).json({ error: '帧数过多，最多 12 张' })
  }

  const prompt = PROMPT.replace('N 张', `${frames.length} 张`).replace('D 秒', `${duration} 秒`)
  const content = [{ type: 'text', text: prompt }]
  for (const f of frames) content.push({ type: 'image_url', image_url: { url: f } })

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
        thinking: { type: 'disabled' },
      }),
    })

    const data = await upstream.json()
    if (!upstream.ok) {
      const msg = data?.error?.message || `视觉模型返回 ${upstream.status}`
      return res.status(upstream.status).json({ error: msg })
    }

    const text = data?.choices?.[0]?.message?.content || ''
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) {
      return res.status(500).json({ error: '模型未返回有效 JSON', raw: text.slice(0, 500) })
    }
    try {
      const parsed = JSON.parse(m[0])
      return res.status(200).json({ analysis: parsed })
    } catch {
      return res.status(500).json({ error: 'JSON 解析失败', raw: text.slice(0, 500) })
    }
  } catch (e) {
    return res.status(502).json({ error: `上游请求失败：${e.message}` })
  }
}
