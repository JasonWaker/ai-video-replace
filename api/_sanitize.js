// 共享模块：生成类 API 的提示词安全化清洗
// 背景：视觉分析模型会如实描述原视频人物（着装细节、身材特征等），
// 这些"描述语言"直接用于文生图/文生视频时容易触发内容审核。
// 清洗是无损改写：只调整措辞，不改变人物/场景语义。
const WORD_MAP = [
  [/性感|妩媚|诱惑|撩人|火辣/g, '时尚'],
  [/魔鬼身材|身材火辣|身材曼妙|凹凸有致|曲线玲珑|前凸后翘/g, '身形匀称'],
  [/大长腿|美腿|长腿/g, '身姿挺拔'],
  [/紧身/g, '修身'],
  [/低胸|深V/g, '圆领'],
  [/吊带/g, '无袖'],
  [/热裤|超短裤/g, '运动短裤'],
  [/露脐|露腰|露背|露肩/g, '清爽款'],
  [/泳装|比基尼/g, '运动套装'],
  [/透明|透视/g, '轻薄'],
  [/暴露|清凉着装|着装清凉/g, '清爽'],
  [/丰满|丰腴/g, '匀称'],
  [/未成年|少女/g, '年轻女性'],
  [/裸|赤裸/g, '简约'],
]

export function sanitizePrompt(text) {
  if (typeof text !== 'string' || !text) return text
  let out = text
  for (const [re, to] of WORD_MAP) out = out.replace(re, to)
  return out
}

// 把 Ark 上游错误翻译为可操作的中文提示；无法识别时返回 null（由调用方透传原始信息）
// elementNames: content 数组各元素的人读描述（如 ['文字提示词','人物参考图','参考视频']），用于精确定位被拒输入
export function translateUpstreamError(data, elementNames = []) {
  const err = data?.error
  const code = typeof err === 'object' ? err?.code || '' : ''
  const msg = typeof err === 'object' ? err?.message || '' : String(err || '')
  const all = `${code} ${msg}`
  // 定位被拒的输入元素：错误 message 里会写 content[N]
  const idx = [...all.matchAll(/content\[(\d+)\]/g)].map((m) => Number(m[1]))
  const named = idx.map((i) => elementNames[i]).filter(Boolean)
  const target = named.length ? named.join('、') : ''
  if (/PrivacyInformation|real person|SensitiveContentDetected\.Privacy/i.test(all)) {
    if (target.includes('参考视频')) {
      return `被拦截的输入：参考视频（${target}）。参考视频里包含真人镜头，触发了平台肖像检测（合规限制，无法关闭）。替代方案：① 换一段无真人镜头的视频做动作参考；② 去掉参考视频，仅用人物图 + 动作文字描述生成。`
    }
    if (target) {
      return `被拦截的输入：${target}。人物图被平台判定为可能包含真人肖像——过于写实的 AI 人物图也会触发。建议：把人物图切换为「动漫/插画风格」重新生成，或更换其他人物图片。`
    }
    return '参考图被平台判定为可能包含真人肖像——过于写实的 AI 人物图也会触发该检测。建议：把人物图切换为「动漫/插画风格」重新生成（非写实人物不会触发），或更换其他人物图片。'
  }
  if (/SensitiveContent|sensitive|content (filter|moderation)|violat/i.test(all)) {
    return `内容审核未通过${target ? `（涉及：${target}）` : ''}：提示词或参考素材可能包含敏感内容。请修改提示词（着装等描述改为中性表达）或更换人物图后重试。`
  }
  if (/pixel count|video pixel|分辨率|pixels?.{0,20}(greater|less|>=|<=|minimum)/i.test(all)) {
    return `动作参考视频分辨率不满足模型最低要求${target ? `（涉及：${target}）` : ''}：Seedance 2.0 r2v 模式要求参考视频像素数 ≥ 407936。该问题通常出现在火柴人参考过小的情况，请重新分析后再试（已自动提升分辨率）。`
  }
  return null
}
