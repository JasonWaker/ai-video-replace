<script setup>
import { ref, computed } from 'vue'
import PromptPicker from './PromptPicker.vue'

// ====== 模型配置（与 App.vue 保持一致） ======
const GEN_MODELS = [
  { id: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5 · 质量最强（推荐）', price: 2.0 },
  { id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 fast · 快且省（0.037元/千tok）', price: 0.8 },
  { id: 'doubao-seedance-2-0-mini-260615', label: 'Seedance 2.0 mini · 最省钱（0.023元/千tok）', price: 0.5 },
]

// ====== 状态 ======
const mode = ref('analyze') // analyze = 上传视频拆动作 | template = 热门舞蹈直出
const step = ref(1)
const busy = ref('')
const errorMsg = ref('')

// 热门舞蹈模板（Seedance 训练数据里有大量这类视频，直接写舞蹈名就能生成）
const DANCE_TEMPLATES = [
  { name: '巴提巴提舞', desc: '双手在胸前比心摆动，胯部左右轻摆，卡点清晰' },
  { name: '科目三', desc: '双手甩动，脚步左右横移，胯部随节奏摆动' },
  { name: '擦玻璃舞', desc: '双手在身前做擦玻璃动作，身体左右摇摆' },
  { name: '摆摆舞', desc: '双手随节拍上下摆动，头部轻晃，节奏明快' },
  { name: '手势舞', desc: '手指在脸前比心、指镜头，头部配合微笑' },
  { name: '摇花手', desc: '双手在胸前快速转圈，身体随节奏律动' },
  { name: 'solo 卡点舞', desc: '随鼓点摆 pose：转身、回头、撩发、叉腰，每拍一个 pose' },
]
const selectedDance = ref('')
const personTpl = ref('')
const sceneTpl = ref('')
const durationTpl = ref(5)
const genModelTpl = ref('doubao-seedance-2-0-mini-260615') // 模板模式默认最省钱

// 视频
const videoFile = ref(null)
const videoObjUrl = ref('')
const videoDuration = ref(0)
const videoW = ref(0)
const videoH = ref(0)
const frames = ref([])
const audioInfo = ref({ hasAudio: false, bpm: 0 })

// 动作脚本
const motion = ref(null) // { scene, camera, timeline: [], narrative }

// 人物设定
const personDesc = ref('')
const refImageUrl = ref('')      // Seedream 生成的参考图 URL
const refImageLoading = ref(false)
const sceneInput = ref('')

// 生成参数
const genModel = ref(GEN_MODELS[0].id)
const duration = ref(5)

// 结果
const taskId = ref('')
const pollLog = ref([])
const videoUrl = ref('')

const currentModel = computed(() => GEN_MODELS.find(m => m.id === genModel.value) || GEN_MODELS[0])
const maxDuration = computed(() => Math.max(3, Math.min(10, Math.round(videoDuration.value) || 5)))
const canGenerate = computed(() => !!motion.value && !!motion.value.narrative && !busy.value)
const downloadHref = computed(() => {
  if (!videoUrl.value) return ''
  const name = `ai-motion-script-${taskId.value || Date.now()}.mp4`
  return `/api/download?url=${encodeURIComponent(videoUrl.value)}&filename=${encodeURIComponent(name)}`
})

// ====== 工具 ======
async function postJSON(path, body, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      const resp = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      if (!resp.ok) {
        const err = data?.error
        let msg = typeof err === 'string' ? err : err?.message || ''
        if (data?.detail && data.detail !== msg) msg += `\n[上游] ${data.detail}`
        if (!msg) msg = JSON.stringify(data) || `HTTP ${resp.status}`
        throw new Error(msg)
      }
      return data
    } catch (e) {
      if (i >= retries || (e.message && !e.message.includes('fetch'))) throw e
      await new Promise(r => setTimeout(r, 1500))
    }
  }
}

function seekTo(video, t) {
  return new Promise(resolve => {
    const on = () => { video.removeEventListener('seeked', on); resolve() }
    video.addEventListener('seeked', on)
    video.currentTime = t
  })
}

async function extractFrames(video, count = 8) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const scale = Math.min(1, 384 / Math.max(video.videoWidth, video.videoHeight))
  canvas.width = Math.max(2, Math.round(video.videoWidth * scale))
  canvas.height = Math.max(2, Math.round(video.videoHeight * scale))
  const out = []
  const dur = video.duration
  for (let i = 0; i < count; i++) {
    await seekTo(video, Math.min(dur - 0.1, dur * (0.03 + (0.94 * i) / Math.max(1, count - 1))))
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    out.push(canvas.toDataURL('image/jpeg', 0.72))
  }
  return out
}

async function analyzeAudioBpm(file) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    const ctx = new AC()
    const buf = await ctx.decodeAudioData(await file.arrayBuffer())
    const data = buf.getChannelData(0)
    const hop = 512, env = []
    for (let i = 0; i + hop < data.length; i += hop) {
      let s = 0
      for (let j = 0; j < hop; j++) s += data[i + j] * data[i + j]
      env.push(Math.sqrt(s / hop))
    }
    const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length)
    const thr = mean * 1.5, peaks = []
    const minGap = Math.round(0.22 * (buf.sampleRate / hop))
    for (let i = 1; i < env.length - 1; i++) {
      if (env[i] > thr && env[i] >= env[i-1] && env[i] >= env[i+1]) {
        if (!peaks.length || i - peaks[peaks.length-1] >= minGap) peaks.push(i)
      }
    }
    let bpm = 0
    if (peaks.length >= 4) {
      const gaps = peaks.slice(1).map((p, i) => (p - peaks[i]) * (hop / buf.sampleRate)).sort((a, b) => a - b)
      const med = gaps[Math.floor(gaps.length / 2)]
      bpm = Math.round(60 / med)
      while (bpm > 180) bpm = Math.round(bpm / 2)
    }
    ctx.close()
    return { hasAudio: true, bpm }
  } catch { return { hasAudio: false, bpm: 0 } }
}

// ====== 事件 ======
function onVideoChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  resetAll()
  videoFile.value = file
  if (videoObjUrl.value) URL.revokeObjectURL(videoObjUrl.value)
  videoObjUrl.value = URL.createObjectURL(file)
}

function onVideoMeta() {
  const v = document.getElementById('scriptVideo')
  videoDuration.value = v.duration || 0
  videoW.value = v.videoWidth || 0
  videoH.value = v.videoHeight || 0
  duration.value = maxDuration.value
}

async function startAnalyze() {
  busy.value = 'analyzing'
  errorMsg.value = ''
  try {
    const v = document.getElementById('scriptVideo')
    if (!frames.value.length) frames.value = await extractFrames(v, 8)
    audioInfo.value = await analyzeAudioBpm(videoFile.value)
    const data = await postJSON('/api/analyze-motion', {
      frames: frames.value,
      duration: Math.round(videoDuration.value) || 10,
    })
    motion.value = data.analysis
    sceneInput.value = data.analysis.scene || ''
    step.value = 2
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    busy.value = ''
  }
}

// 用 Seedream 生成人物参考图
async function generateRefImage() {
  refImageLoading.value = true
  errorMsg.value = ''
  try {
    const prompt = personDesc.value.trim()
      ? `写实人像摄影，9:16竖屏，全身中景，${personDesc.value.trim()}，站在${sceneInput.value.trim() || '自然光线下'}，姿态自然，表情微笑看向镜头，皮肤通透，高清细腻，电影感光线`
      : `写实人像摄影，9:16竖屏，全身中景，一位时尚年轻女性，穿优雅香槟色长裙，自然站立在${sceneInput.value.trim() || '高端度假酒店'}，暖金色光线，表情微笑看向镜头，皮肤通透，高清细腻`
    const data = await postJSON('/api/seedream', { prompt, size: '1080x1920' })
    refImageUrl.value = data.image_url
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    refImageLoading.value = false
  }
}

async function generate() {
  busy.value = 'generating'
  taskId.value = ''
  pollLog.value = []
  videoUrl.value = ''
  errorMsg.value = ''
  try {
    const bpmTxt = audioInfo.value?.bpm ? `，节奏约 ${audioInfo.value.bpm} BPM` : ''
    // 把 timeline 转成"[X.Xs] 动作"分镜表，这是模型最容易执行的格式
    const shotList = (motion.value.timeline || []).map(kf => {
      const parts = []
      if (kf.head) parts.push(kf.head)
      if (kf.arm) parts.push(kf.arm)
      if (kf.waist) parts.push(kf.waist)
      if (kf.hip) parts.push(kf.hip)
      if (kf.eye) parts.push(kf.eye)
      if (kf.expression) parts.push(kf.expression)
      return `[${kf.t?.toFixed?.(1) ?? kf.t}s] ${parts.join('，')}`
    }).join('\n')

    const text = [
      `生成一段 ${duration.value} 秒的写实风格短视频，固定机位中全景，镜头稳定无运镜，灯光与背景全程保持一致。${bpmTxt}。`,
      refImageUrl.value ? '人物形象以参考图为准（严格保持同一人）。' : (personDesc.value.trim()
        ? `人物：${personDesc.value.trim()}，人物形象全程保持一致。`
        : '人物：由你创作的一位全新时尚人物，形象全程保持一致。'),
      `场景：${sceneInput.value.trim() || motion.value.scene || '光线均匀的场景'}。`,
      `【严格按以下分镜表执行，每个时间点的动作必须精确对应，不要自由发挥、不要跳过任何一个动作点】：\n${shotList}`,
      motion.value.narrative ? `动作补充说明：${motion.value.narrative}` : '',
      motion.value.camera ? `镜头参考：${motion.value.camera}` : '',
      '动作之间流畅过渡，卡点干脆。禁止出现任何文字、水印、Logo；禁止真人肖像。',
    ].filter(Boolean).join('\n\n')

    const content = [{ type: 'text', text }]
    if (refImageUrl.value) {
      content.push({ type: 'image_url', image_url: { url: refImageUrl.value } })
    }

    const d = await postJSON('/api/generate', {
      model: genModel.value,
      content,
      duration: duration.value,
      ratio: videoH.value > videoW.value ? '9:16' : '16:9',
      generate_audio: true,
      watermark: false,
    })
    taskId.value = d.task_id
    pollLog.value.push(`✓ 任务已创建：${taskId.value}`)
    if (refImageUrl.value) pollLog.value.push('✓ 已附带人物参考图')
    else pollLog.value.push('ℹ 纯文字生成（无参考图）')

    const start = Date.now()
    while (true) {
      const elapsed = Math.floor((Date.now() - start) / 1000)
      if (elapsed > 600) throw new Error('超时（10分钟未完成）')
      let data
      try {
        const resp = await fetch(`/api/task?task_id=${encodeURIComponent(taskId.value)}`)
        data = await resp.json()
        if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`)
      } catch (e) {
        pollLog.value.push(`[${elapsed}s] 查询失败，8s 后重试`)
        await new Promise(r => setTimeout(r, 8000))
        continue
      }
      pollLog.value.push(`[${elapsed}s] 状态：${data.status}`)
      if (data.status === 'succeeded') {
        const c = data.content
        const items = Array.isArray(c) ? c : c && typeof c === 'object' ? [c] : []
        for (const item of items) {
          const u = typeof item?.video_url === 'string' ? item.video_url : (item?.video_url?.url || item?.url)
          if (u && String(u).startsWith('http')) { videoUrl.value = u; break }
        }
        if (!videoUrl.value) throw new Error('任务成功但未找到视频 URL')
        pollLog.value.push('✓ 视频生成完成！')
        step.value = 3
        break
      }
      if (['failed', 'expired', 'canceled', 'cancelled'].includes(data.status)) {
        throw new Error(`任务${data.status}：${JSON.stringify(data.error || '')}`)
      }
      await new Promise(r => setTimeout(r, 8000))
    }
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    busy.value = ''
  }
}

// ====== 热门舞蹈模板直出（纯文生视频，最便宜） ======
async function generateTemplate() {
  if (!selectedDance.value) {
    errorMsg.value = '请先选一个舞蹈模板'
    return
  }
  busy.value = 'generating'
  taskId.value = ''
  pollLog.value = []
  videoUrl.value = ''
  errorMsg.value = ''
  try {
    const dance = DANCE_TEMPLATES.find(d => d.name === selectedDance.value)
    const text = [
      `生成一段 ${durationTpl.value} 秒的写实风格短视频，竖屏 9:16，固定机位中全景，镜头稳定，灯光与背景全程一致。`,
      personTpl.value.trim()
        ? `人物：${personTpl.value.trim()}，人物形象全程保持一致。`
        : '人物：一位时尚年轻女性，形象全程保持一致。',
      `场景：${sceneTpl.value.trim() || '光线均匀的室内场景'}。`,
      `动作：跳【${selectedDance.value}】，具体动作要点：${dance?.desc || selectedDance.value}，随音乐鼓点卡点，动作干脆有力。`,
      '禁止出现任何文字、水印、Logo；禁止真人肖像。',
    ].filter(Boolean).join('\n')

    pollLog.value.push(`开始生成：${selectedDance.value}（模型：${genModelTpl.value.includes('mini') ? 'mini 最省' : genModelTpl.value.includes('fast') ? 'fast' : '2.5'}）`)
    const d = await postJSON('/api/generate', {
      model: genModelTpl.value,
      content: [{ type: 'text', text }],
      duration: durationTpl.value,
      ratio: '9:16',
      generate_audio: true,
      watermark: false,
    })
    taskId.value = d.task_id
    pollLog.value.push(`✓ 任务已创建：${taskId.value}`)

    const start = Date.now()
    while (true) {
      const elapsed = Math.floor((Date.now() - start) / 1000)
      if (elapsed > 600) throw new Error('超时（10分钟未完成）')
      let data
      try {
        const resp = await fetch(`/api/task?task_id=${encodeURIComponent(taskId.value)}`)
        data = await resp.json()
        if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`)
      } catch (e) {
        pollLog.value.push(`[${elapsed}s] 查询失败，8s 后重试`)
        await new Promise(r => setTimeout(r, 8000))
        continue
      }
      pollLog.value.push(`[${elapsed}s] 状态：${data.status}`)
      if (data.status === 'succeeded') {
        const c = data.content
        const items = Array.isArray(c) ? c : c && typeof c === 'object' ? [c] : []
        for (const item of items) {
          const u = typeof item?.video_url === 'string' ? item.video_url : (item?.video_url?.url || item?.url)
          if (u && String(u).startsWith('http')) { videoUrl.value = u; break }
        }
        if (!videoUrl.value) throw new Error('任务成功但未找到视频 URL')
        pollLog.value.push('✓ 视频生成完成！')
        step.value = 3
        break
      }
      if (['failed', 'expired', 'canceled', 'cancelled'].includes(data.status)) {
        throw new Error(`任务${data.status}：${JSON.stringify(data.error || '')}`)
      }
      await new Promise(r => setTimeout(r, 8000))
    }
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    busy.value = ''
  }
}

function resetAll() {
  step.value = 1
  motion.value = null
  personDesc.value = ''
  refImageUrl.value = ''
  sceneInput.value = ''
  taskId.value = ''
  pollLog.value = []
  videoUrl.value = ''
  errorMsg.value = ''
  frames.value = []
}
</script>

<template>
  <div class="space-y-6">
    <!-- 模式切换 -->
    <div class="flex gap-1 bg-gray-800/60 rounded-lg p-1 w-fit">
      <button @click="mode = 'analyze'"
        class="px-4 py-1.5 text-xs rounded-md transition"
        :class="mode === 'analyze' ? 'bg-cyan-600 text-white' : 'text-gray-400 hover:text-gray-200'">
        📤 上传视频拆动作
      </button>
      <button @click="mode = 'template'"
        class="px-4 py-1.5 text-xs rounded-md transition"
        :class="mode === 'template' ? 'bg-amber-600 text-white' : 'text-gray-400 hover:text-gray-200'">
        ⚡ 热门舞蹈模板（最省钱）
      </button>
    </div>

    <div class="bg-gradient-to-r from-cyan-950/40 to-blue-950/30 border border-cyan-800/50 rounded-xl p-4 text-xs text-cyan-200/80 leading-relaxed">
      <template v-if="mode === 'analyze'">
        💡 <b>动作脚本直出</b>：把原视频交给视觉模型拆解成"按秒动作时间轴"，再把这份纯文字脚本喂给 Seedance 图生视频。<b>全程不把原视频/真人画面发给生成模型</b>，过审率远高于直接喂参考视频。动作精度约 70–80%（神似），要 100% 复刻请用"火柴人复刻"页签。
      </template>
      <template v-else>
        ⚡ <b>热门舞蹈模板</b>：Seedance 训练数据里有大量巴提巴提、科目三这类爆火舞蹈，直接选模板 + 写人物/场景，纯文生视频，<b>5 秒成本约 ¥2.5</b>（用 mini 模型），是目前最便宜的卡点舞方案。
      </template>
    </div>

    <div v-if="errorMsg" class="bg-red-950/50 border border-red-800 rounded-xl p-4 text-sm text-red-300 whitespace-pre-line">
      ⚠ {{ errorMsg }}
    </div>

    <!-- ===== 热门舞蹈模板模式 ===== -->
    <div v-if="mode === 'template' && !videoUrl" class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
      <div>
        <label class="text-xs text-gray-500 block mb-2">① 选舞蹈模板</label>
        <div class="flex flex-wrap gap-2">
          <button v-for="d in DANCE_TEMPLATES" :key="d.name" @click="selectedDance = d.name"
            class="px-3 py-1.5 text-xs rounded-lg border transition"
            :class="selectedDance === d.name
              ? 'bg-amber-600 text-white border-amber-500'
              : 'bg-gray-800 text-gray-300 border-gray-700 hover:border-amber-500'">
            {{ d.name }}
          </button>
        </div>
        <div v-if="selectedDance" class="text-[11px] text-gray-500 mt-2">
          动作要点：{{ DANCE_TEMPLATES.find(d => d.name === selectedDance)?.desc }}
        </div>
      </div>

      <div>
        <label class="text-xs text-gray-500 flex items-center gap-2">② 人物描述
          <PromptPicker v-model="personTpl" />
        </label>
        <textarea v-model="personTpl" rows="2" placeholder="例：两位年轻东亚女性，穿香槟色亮片裙"
          class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700 focus:border-amber-500 focus:outline-none resize-none"></textarea>
      </div>

      <div>
        <label class="text-xs text-gray-500 flex items-center gap-2">③ 场景
          <PromptPicker v-model="sceneTpl" />
        </label>
        <input v-model="sceneTpl" placeholder="例：无边泳池边傍晚"
          class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700 focus:border-amber-500 focus:outline-none"/>
      </div>

      <div class="grid sm:grid-cols-2 gap-3">
        <div>
          <label class="text-xs text-gray-500">模型（模板模式推荐 mini 最省）</label>
          <select v-model="genModelTpl" class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700">
            <option value="doubao-seedance-2-0-mini-260615">Seedance 2.0 mini（≈¥2.5/5s）</option>
            <option value="doubao-seedance-2-0-fast-260128">Seedance 2.0 fast（≈¥4/5s）</option>
            <option value="doubao-seedance-2-5-260628">Seedance 2.5（≈¥10/5s）</option>
          </select>
        </div>
        <div>
          <label class="text-xs text-gray-500">时长</label>
          <select v-model.number="durationTpl" class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700">
            <option :value="5">5 秒</option>
            <option :value="10">10 秒</option>
          </select>
        </div>
      </div>

      <button @click="generateTemplate" :disabled="busy === 'generating' || !selectedDance"
        class="w-full py-3 bg-gradient-to-r from-amber-600 to-orange-600 disabled:opacity-40 rounded-lg font-medium text-white">
        {{ busy === 'generating' ? '生成中…' : `⚡ 生成「${selectedDance || '舞蹈模板'}」` }}
      </button>

      <div v-if="pollLog.length" class="bg-gray-800/60 rounded-lg p-3">
        <div class="text-xs text-gray-500 mb-1">进度</div>
        <div class="font-mono text-xs space-y-1 max-h-32 overflow-y-auto">
          <div v-for="(log, i) in pollLog" :key="i" class="text-gray-400">{{ log }}</div>
        </div>
      </div>
    </div>

    <!-- 模板模式结果 -->
    <div v-if="mode === 'template' && videoUrl" class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-3">
      <video :src="videoUrl" controls autoplay class="w-full rounded-lg"></video>
      <div class="flex gap-3">
        <a :href="downloadHref" class="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm">⬇ 下载</a>
        <button @click="() => { videoUrl = ''; selectedDance = ''; step = 1 }" class="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm">🔄 再来一条</button>
      </div>
    </div>

    <!-- Step 1: 上传 -->
    <div v-if="mode === 'analyze' && step === 1" class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
      <div class="flex items-center gap-2">
        <span class="w-6 h-6 rounded-full bg-cyan-600 text-white text-xs flex items-center justify-center font-bold">1</span>
        <span class="font-medium">上传参考视频</span>
        <span class="text-xs text-gray-500">只需拆动作，不会把原视频发给生成模型</span>
      </div>
      <label class="block border-2 border-dashed border-gray-700 hover:border-cyan-500 rounded-xl p-8 text-center cursor-pointer transition">
        <input type="file" accept="video/*" class="hidden" @change="onVideoChange" />
        <div v-if="!videoFile" class="text-gray-500">
          <div class="text-3xl mb-2">📤</div>
          <div class="text-sm">点击选择视频</div>
          <div class="text-xs text-gray-600 mt-1">建议 5–15 秒卡点舞</div>
        </div>
        <div v-else class="text-sm text-gray-400">✓ {{ videoFile.name }}</div>
      </label>
      <div v-if="videoObjUrl" class="space-y-3">
        <video id="scriptVideo" :src="videoObjUrl" controls @loadedmetadata="onVideoMeta"
          class="w-full max-h-80 rounded-lg bg-black"></video>
        <div class="flex flex-wrap gap-3 text-xs text-gray-500">
          <span v-if="videoDuration">时长 {{ videoDuration.toFixed(1) }}s</span>
          <span v-if="videoW">{{ videoW }}×{{ videoH }}</span>
        </div>
        <button @click="startAnalyze" :disabled="!!busy"
          class="w-full py-3 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:opacity-40 rounded-lg font-medium text-white transition">
          {{ busy === 'analyzing' ? '拆解动作脚本中…（约10-20秒）' : '🔍 拆解动作脚本' }}
        </button>
      </div>
    </div>

    <!-- Step 2: 脚本编辑 + 人物设定 -->
    <div v-if="mode === 'analyze' && step === 2 && motion" class="space-y-6">
      <!-- 动作时间轴 -->
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-3">
        <div class="flex items-center gap-2">
          <span class="w-6 h-6 rounded-full bg-cyan-600 text-white text-xs flex items-center justify-center font-bold">2</span>
          <span class="font-medium">动作时间轴（可直接编辑）</span>
          <span class="text-xs text-gray-500">每 1 秒一个 keyframe</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="text-gray-500">
              <tr class="border-b border-gray-800">
                <th class="py-2 pr-2 text-left">t</th>
                <th class="py-2 px-2 text-left">头部</th>
                <th class="py-2 px-2 text-left">手臂</th>
                <th class="py-2 px-2 text-left">腰部</th>
                <th class="py-2 px-2 text-left">胯部</th>
                <th class="py-2 px-2 text-left">视线</th>
                <th class="py-2 px-2 text-left">表情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(kf, i) in motion.timeline" :key="i" class="border-b border-gray-800/50">
                <td class="py-1 pr-2 font-mono text-cyan-400">{{ kf.t?.toFixed(1) }}s</td>
                <td class="py-1 px-2"><input v-model="kf.head" class="w-full bg-gray-800 rounded px-2 py-1 outline-none focus:border-cyan-500 border border-gray-700"/></td>
                <td class="py-1 px-2"><input v-model="kf.arm" class="w-full bg-gray-800 rounded px-2 py-1 outline-none focus:border-cyan-500 border border-gray-700"/></td>
                <td class="py-1 px-2"><input v-model="kf.waist" class="w-full bg-gray-800 rounded px-2 py-1 outline-none focus:border-cyan-500 border border-gray-700"/></td>
                <td class="py-1 px-2"><input v-model="kf.hip" class="w-full bg-gray-800 rounded px-2 py-1 outline-none focus:border-cyan-500 border border-gray-700"/></td>
                <td class="py-1 px-2"><input v-model="kf.eye" class="w-full bg-gray-800 rounded px-2 py-1 outline-none focus:border-cyan-500 border border-gray-700"/></td>
                <td class="py-1 px-2"><input v-model="kf.expression" class="w-full bg-gray-800 rounded px-2 py-1 outline-none focus:border-cyan-500 border border-gray-700"/></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <label class="text-xs text-gray-500">自然语言动作脚本（直接喂给视频模型，可改）</label>
          <textarea v-model="motion.narrative" rows="4"
            class="w-full mt-1 bg-gray-800 rounded-lg px-4 py-2 text-sm border border-gray-700 focus:border-cyan-500 focus:outline-none resize-none"></textarea>
        </div>
      </div>

      <!-- 人物设定 -->
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
        <div class="text-sm font-medium flex items-center gap-2">
          <span class="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">3</span>
          人物设定（选填）
        </div>

        <div>
          <label class="text-xs text-gray-500 flex items-center gap-2">
            人物形象描述（留空 = 模型自设计；建议写"两位年轻东亚女性，香槟色长裙，泳池边"这类中性词）
            <PromptPicker v-model="personDesc" />
          </label>
          <textarea v-model="personDesc" rows="2" placeholder="例：两位年轻东亚女性，一位齐肩短发穿香槟色短裙，一位长卷发穿香槟色长裙"
            class="w-full mt-1 bg-gray-800 rounded-lg px-4 py-2 text-sm border border-gray-700 focus:border-cyan-500 focus:outline-none resize-none"></textarea>
        </div>

        <div>
          <label class="text-xs text-gray-500 flex items-center gap-2">场景（覆盖原片场景）
            <PromptPicker v-model="sceneInput" />
          </label>
          <input v-model="sceneInput" class="w-full mt-1 bg-gray-800 rounded-lg px-4 py-2 text-sm border border-gray-700 focus:border-cyan-500 focus:outline-none"/>
        </div>

        <div class="flex gap-3 items-center">
          <button @click="generateRefImage" :disabled="refImageLoading"
            class="px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white rounded-lg text-xs">
            {{ refImageLoading ? '生成参考图中…' : '🎨 用 Seedream 生成人物参考图（推荐，保证人物一致）' }}
          </button>
          <span class="text-xs text-gray-500">≈¥0.2/张</span>
        </div>
        <div v-if="refImageUrl" class="flex gap-3 items-start">
          <img :src="refImageUrl" class="w-32 rounded-lg border border-gray-700"/>
          <div class="text-xs text-gray-400 leading-relaxed pt-2">
            ✓ 已生成参考图，将作为首帧喂给 Seedance。<br/>
            不满意？改完人物描述后再点一次"生成参考图"。
          </div>
        </div>
      </div>

      <!-- 生成参数 -->
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-3">
        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label class="text-xs text-gray-500">生成模型</label>
            <select v-model="genModel" class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700">
              <option v-for="m in GEN_MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-gray-500">生成时长（≤ 原片）</label>
            <select v-model.number="duration" class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700">
              <option v-for="d in maxDuration" :key="d" :value="d" v-show="d >= 3">{{ d }}秒</option>
            </select>
          </div>
        </div>

        <button @click="generate" :disabled="!canGenerate"
          class="w-full py-3 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:opacity-40 rounded-lg font-medium text-white transition">
          {{ busy === 'generating' ? '生成中…' : '🎬 开始生成（纯图生视频，不过真人审核）' }}
        </button>
      </div>

      <div v-if="pollLog.length" class="bg-gray-900 rounded-xl p-4 border border-gray-800">
        <div class="text-xs text-gray-500 mb-2">任务进度</div>
        <div class="font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
          <div v-for="(log, i) in pollLog" :key="i" class="text-gray-400">{{ log }}</div>
        </div>
      </div>
    </div>

    <!-- Step 3: 结果 -->
    <div v-if="mode === 'analyze' && step === 3" class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-3">
      <div class="flex items-center gap-2">
        <span class="w-6 h-6 rounded-full bg-green-600 text-white text-xs flex items-center justify-center font-bold">✓</span>
        <span class="font-medium">生成结果</span>
      </div>
      <video :src="videoUrl" controls autoplay class="w-full rounded-lg"></video>
      <div class="flex flex-wrap items-center gap-3">
        <a :href="downloadHref" class="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm">⬇ 下载视频</a>
        <button @click="resetAll" class="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm">🔄 下一条</button>
      </div>
    </div>
  </div>
</template>
