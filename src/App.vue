<script setup>
import { ref, computed } from 'vue'
import { upload } from '@vercel/blob/client'
import { extractSkeletonVideo } from './pose.js'
import MotionScript from './MotionScript.vue'
import FfmpegBeat from './FfmpegBeat.vue'

// 页签：stickman = 火柴人复刻（原流程） | script = 动作脚本直出 | ffmpeg = 卡点图文视频
const tab = ref('stickman')

// ====== 生成模型配置（price 为参考单价：元/秒；2.0 系列按 token 计费，按 720p 实测 108900 tok/5s 换算） ======
const GEN_MODELS = [
  { id: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5 · 质量最强（推荐）', price: 2.0 },
  { id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 fast · 快且省（0.037元/千tok）', price: 0.8 },
  { id: 'doubao-seedance-2-0-mini-260615', label: 'Seedance 2.0 mini · 最省钱（0.023元/千tok）', price: 0.5 },
]
const RETRY_RATE = 0.1

// ====== 全局状态 ======
const step = ref(1) // 1 上传 | 2 分析与替换 | 3 生成结果
const busy = ref('') // uploading | analyzing | generating
const errorMsg = ref('')

// 步骤1：参考视频
const videoFile = ref(null)
const videoObjUrl = ref('')
const videoDuration = ref(0)
const videoW = ref(0)
const videoH = ref(0)
const frames = ref([]) // dataURL[]
const audioInfo = ref({ hasAudio: false, bpm: 0 })

// 步骤2：分析结果与提示词微调（人物形象由模型按提示词自行生成，不再上传/生成人物图）
const analysis = ref(null)
const genModel = ref(GEN_MODELS[0].id)
const personDesc = ref('') // 人物形象描述（留空 = 模型自行设计）
const sceneInput = ref('')
const motionInput = ref('')
const duration = ref(5)

// 动作参考（火柴人）：poseState idle|running|done|error
const stickman = ref(null) // { blob, ext, url, frames, fps }
const poseState = ref('idle')
const poseProgress = ref({ done: 0, total: 0 })
const poseError = ref('')

const currentModel = computed(() => GEN_MODELS.find((m) => m.id === genModel.value) || GEN_MODELS[0])

// 步骤3：生成
const taskId = ref('')
const pollLog = ref([])
const videoUrl = ref('')

const maxDuration = computed(() => Math.max(3, Math.min(10, Math.round(videoDuration.value) || 5)))
const cost = computed(() => {
  const base = currentModel.value.price * duration.value
  const retry = base * RETRY_RATE
  return {
    base: Math.round(base * 100) / 100,
    retry: Math.round(retry * 100) / 100,
    total: Math.round((base + retry) * 100) / 100,
  }
})
const downloadHref = computed(() => {
  if (!videoUrl.value) return ''
  const name = `ai-video-replace-${taskId.value || Date.now()}.mp4`
  return `/api/download?url=${encodeURIComponent(videoUrl.value)}&filename=${encodeURIComponent(name)}`
})
const canAnalyze = computed(() => !!videoFile.value && !busy.value)
const canGenerate = computed(() => !!analysis.value && !busy.value)

// ====== 通用请求（网络错误自动重试 2 次，应对移动网络波动） ======
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
        if (data?.detail && data.detail !== msg) msg += `\n[上游原始信息] ${data.detail}`
        if (!msg) msg = JSON.stringify(data) || `HTTP ${resp.status}`
        throw new Error(msg)
      }
      return data
    } catch (e) {
      // 服务端返回的业务错误不重试；网络层失败（Failed to fetch 等）重试
      if (i >= retries || (e.message && !e.message.includes('fetch'))) throw e
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
}

// ====== 视频选择 → 预览 + 抽帧 + 音频分析 + 后台上传 ======
function onVideoChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  resetRun()
  videoFile.value = file
  if (videoObjUrl.value) URL.revokeObjectURL(videoObjUrl.value)
  videoObjUrl.value = URL.createObjectURL(file)
  frames.value = []
  analysis.value = null
  clearStickman()
}

function clearStickman() {
  if (stickman.value?.url) URL.revokeObjectURL(stickman.value.url)
  stickman.value = null
  poseState.value = 'idle'
  poseProgress.value = { done: 0, total: 0 }
  poseError.value = ''
}

function onVideoMeta() {
  const v = document.getElementById('refVideo')
  videoDuration.value = v.duration || 0
  videoW.value = v.videoWidth || 0
  videoH.value = v.videoHeight || 0
  duration.value = maxDuration.value
}

function seekTo(video, t) {
  return new Promise((resolve) => {
    const on = () => {
      video.removeEventListener('seeked', on)
      resolve()
    }
    video.addEventListener('seeked', on)
    video.currentTime = t
  })
}

async function extractFrames(video, count = 6) {
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
    const hop = 512
    const env = []
    for (let i = 0; i + hop < data.length; i += hop) {
      let s = 0
      for (let j = 0; j < hop; j++) s += data[i + j] * data[i + j]
      env.push(Math.sqrt(s / hop))
    }
    const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length)
    const thr = mean * 1.5
    const peaks = []
    const minGap = Math.round(0.22 * (buf.sampleRate / hop))
    for (let i = 1; i < env.length - 1; i++) {
      if (env[i] > thr && env[i] >= env[i - 1] && env[i] >= env[i + 1]) {
        if (!peaks.length || i - peaks[peaks.length - 1] >= minGap) peaks.push(i)
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
  } catch {
    return { hasAudio: false, bpm: 0 }
  }
}

async function startAnalyze() {
  busy.value = 'analyzing'
  errorMsg.value = ''
  try {
    const v = document.getElementById('refVideo')
    if (!frames.value.length) frames.value = await extractFrames(v)
    audioInfo.value = await analyzeAudioBpm(videoFile.value)

    // 火柴人提取（占用 video 元素）与视觉分析（纯网络请求）并行
    const posePromise = runPoseExtraction(v)
    const data = await postJSON('/api/analyze', { frames: frames.value })
    analysis.value = data.analysis
    sceneInput.value = data.analysis.scene || ''
    motionInput.value = data.analysis.motion || ''
    personDesc.value = '' // 人物形象默认留空，由模型自行设计
    step.value = 2
    await posePromise // 等动作参考就绪（进度条可见）
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    busy.value = ''
  }
}

// 提取骨架火柴人视频作为动作参考；失败则降级纯提示词生成
async function runPoseExtraction(video) {
  stickman.value = null
  poseError.value = ''
  poseProgress.value = { done: 0, total: 0 }
  poseState.value = 'running'
  try {
    const r = await extractSkeletonVideo(video, {
      fps: 15,
      onProgress: (done, total) => { poseProgress.value = { done, total } },
    })
    stickman.value = { blob: r.blob, ext: r.ext, frames: r.frames, fps: r.fps, url: URL.createObjectURL(r.blob) }
    poseState.value = 'done'
  } catch (e) {
    poseError.value = e.message || '未知错误'
    poseState.value = 'error'
  }
}

// ====== 生成 ======
function resetRun() {
  taskId.value = ''
  pollLog.value = []
  videoUrl.value = ''
  errorMsg.value = ''
}

async function generate() {
  busy.value = 'generating'
  resetRun()
  try {
    // 有火柴人动作参考则上传并随请求发送（动作节奏锁定）；否则纯提示词生成
    let refUrl = ''
    if (stickman.value) {
      try {
        pollLog.value.push('上传动作参考视频…')
        const up = await upload(`stickman/${Date.now()}.${stickman.value.ext}`, stickman.value.blob, {
          access: 'public',
          handleUploadUrl: '/api/client-upload',
        })
        refUrl = up.url
        pollLog.value.push('✓ 动作参考已上传')
      } catch (e) {
        pollLog.value.push(`⚠ 动作参考上传失败（${e.message}），改用纯文字生成`)
      }
    }

    const bpmTxt = audioInfo.value?.bpm ? `，节奏约 ${audioInfo.value.bpm} BPM` : ''
    const text = refUrl
      ? [
          `参考视频是黑白火柴人动作演示，表示目标动作的时间轴：生成的真实人物视频在动作内容、动作节奏与镜头运动上必须与火柴人演示保持一致。画面中不要出现火柴人或骨架形象。`,
          `生成一段 ${duration.value} 秒的舞蹈视频，画面质感写实、镜头稳定。`,
          personDesc.value.trim()
            ? `人物：${personDesc.value.trim()}`
            : `人物：由你创作的一位全新人物（时尚活力的年轻舞者，发型、长相、服装均由你设计，人物形象全程保持一致）。`,
          `场景：${sceneInput.value.trim() || analysis.value?.scene || '光线均匀的舞台或街头舞蹈场景'}`,
          motionInput.value.trim() ? `动作补充要求：${motionInput.value.trim()}` : '',
        ].filter(Boolean).join(' ')
      : [
          `生成一段 ${duration.value} 秒的舞蹈视频，画面质感写实、镜头稳定。`,
          personDesc.value.trim()
            ? `人物：${personDesc.value.trim()}`
            : `人物：由你创作的一位全新人物（时尚活力的年轻舞者，发型、长相、服装均由你设计，人物形象全程保持一致）。`,
          `场景：${sceneInput.value.trim() || analysis.value?.scene || '光线均匀的舞台或街头舞蹈场景'}`,
          `动作：${motionInput.value.trim() || analysis.value?.motion || '跟随音乐起舞，动作流畅、卡点准确'}${bpmTxt}`,
          analysis.value?.camera ? `镜头：${analysis.value.camera}` : '',
        ].filter(Boolean).join(' ')

    const content = [{ type: 'text', text }]
    if (refUrl) content.push({ type: 'video_url', video_url: { url: refUrl }, role: 'reference_video' })

    const d = await postJSON('/api/generate', {
      model: genModel.value,
      content,
      duration: duration.value,
      ratio: videoW.value && videoH.value && videoH.value > videoW.value ? '9:16' : '16:9',
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
        pollLog.value.push(`[${elapsed}s] 查询暂失败，8秒后重试（${e.message}）`)
        await new Promise((r) => setTimeout(r, 8000))
        continue
      }
      const status = String(data.status || '')
      pollLog.value.push(`[${elapsed}s] 状态：${status}`)
      if (status === 'succeeded') {
        // content 可能是数组 [{video_url:{url}}]、单对象 {video_url:...} 或字符串，统一兼容
        const c = data.content
        const items = Array.isArray(c) ? c : c && typeof c === 'object' ? [c] : []
        for (const item of items) {
          const u = typeof item?.video_url === 'string' ? item.video_url
            : (item?.video_url?.url || item?.url)
          if (u && String(u).startsWith('http')) { videoUrl.value = u; break }
        }
        if (!videoUrl.value) throw new Error('任务成功但未找到视频 URL')
        pollLog.value.push('✓ 视频生成完成！')
        step.value = 3
        break
      }
      if (['failed', 'expired', 'canceled', 'cancelled'].includes(status)) {
        throw new Error(`任务${status}：${JSON.stringify(data.error || '')}`)
      }
      await new Promise((r) => setTimeout(r, 8000))
    }
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    busy.value = ''
  }
}

function restart() {
  step.value = 1
  resetRun()
  videoFile.value = null
  videoObjUrl.value && URL.revokeObjectURL(videoObjUrl.value)
  videoObjUrl.value = ''
  frames.value = []
  analysis.value = null
  personDesc.value = ''
  sceneInput.value = ''
  motionInput.value = ''
  clearStickman()
}
</script>

<template>
  <div class="min-h-screen bg-gray-950 text-gray-100">
    <header class="border-b border-gray-800 px-6 py-4">
      <div class="max-w-4xl mx-auto flex items-center justify-between">
        <h1 class="text-xl font-bold flex items-center gap-2">
          <span class="text-2xl">🎬</span> AI 视频同款生成
          <span class="text-xs text-gray-500 font-normal ml-2">上传视频 · AI 分析要素 · 提示词生成新视频</span>
        </h1>
        <button v-if="tab === 'stickman' && step > 1" @click="restart" class="text-xs text-gray-400 hover:text-gray-200">↺ 重新开始</button>
      </div>
      <!-- 页签切换 -->
      <div class="max-w-4xl mx-auto mt-3 flex gap-1 bg-gray-800/60 rounded-lg p-1 w-fit">
        <button @click="tab = 'stickman'"
          class="px-4 py-1.5 text-xs rounded-md transition"
          :class="tab === 'stickman' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'">
          🕺 火柴人复刻
        </button>
        <button @click="tab = 'script'"
          class="px-4 py-1.5 text-xs rounded-md transition"
          :class="tab === 'script' ? 'bg-cyan-600 text-white' : 'text-gray-400 hover:text-gray-200'">
          📝 动作脚本直出
        </button>
        <button @click="tab = 'ffmpeg'"
          class="px-4 py-1.5 text-xs rounded-md transition"
          :class="tab === 'ffmpeg' ? 'bg-orange-600 text-white' : 'text-gray-400 hover:text-gray-200'">
          ⚡ FFmpeg 卡点图文
        </button>
      </div>
    </header>

    <main v-if="tab === 'stickman'" class="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <!-- 错误 -->
      <div v-if="errorMsg" class="bg-red-950/50 border border-red-800 rounded-xl p-4 text-sm text-red-300 whitespace-pre-line">
        ⚠ {{ errorMsg }}
      </div>

      <!-- ===== 步骤 1：上传参考视频 ===== -->
      <div v-if="step === 1" class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
        <div class="flex items-center gap-2">
          <span class="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-bold">1</span>
          <span class="font-medium">上传参考视频</span>
          <span class="text-xs text-gray-500">卡点舞、舞蹈片段等；将保留其动作节奏，替换人物与场景</span>
        </div>

        <label class="block border-2 border-dashed border-gray-700 hover:border-indigo-500 rounded-xl p-8 text-center cursor-pointer transition">
          <input type="file" accept="video/*" class="hidden" @change="onVideoChange" />
          <div v-if="!videoFile" class="text-gray-500">
            <div class="text-3xl mb-2">📤</div>
            <div class="text-sm">点击选择或拖拽视频文件</div>
            <div class="text-xs text-gray-600 mt-1">建议 5–15 秒；分析将取前 {{ maxDuration }} 秒生成</div>
          </div>
          <div v-else class="text-sm text-gray-400">
            ✓ {{ videoFile.name }}（{{ (videoFile.size / 1024 / 1024).toFixed(1) }} MB）
          </div>
        </label>

        <div v-if="videoObjUrl" class="space-y-3">
          <video
            id="refVideo" :src="videoObjUrl" controls
            @loadedmetadata="onVideoMeta"
            class="w-full max-h-80 rounded-lg bg-black"
          ></video>

          <!-- 抽帧缩略图 -->
          <div v-if="frames.length" class="grid grid-cols-6 gap-1.5">
            <img v-for="(f, i) in frames" :key="i" :src="f" class="rounded border border-gray-800 aspect-video object-cover" />
          </div>

          <div class="flex flex-wrap gap-3 text-xs text-gray-500">
            <span v-if="videoDuration">时长 {{ videoDuration.toFixed(1) }}s</span>
            <span v-if="videoW">{{ videoW }}×{{ videoH }}</span>
            <span v-if="audioInfo.hasAudio">音频 ✓<template v-if="audioInfo.bpm"> · 约 {{ audioInfo.bpm }} BPM</template></span>
          </div>

          <button
            @click="startAnalyze" :disabled="!canAnalyze"
            class="w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg font-medium text-white transition"
          >{{ busy === 'analyzing' ? '分析要素 + 提取动作骨架中…（约30-90秒）' : '🔍 分析视频要素' }}</button>
        </div>
      </div>

      <!-- ===== 步骤 2：分析结果 + 提示词微调 ===== -->
      <div v-if="step === 2" class="space-y-6">
        <!-- 分析结果 -->
        <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
          <div class="flex items-center gap-2">
            <span class="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-bold">2</span>
            <span class="font-medium">视频要素分析结果</span>
            <span class="text-xs text-gray-500">确认后微调提示词，一键生成同款</span>
          </div>

          <div class="grid grid-cols-6 gap-1.5">
            <img v-for="(f, i) in frames" :key="i" :src="f" class="rounded border border-gray-800 aspect-video object-cover" />
          </div>

          <div class="grid sm:grid-cols-2 gap-3 text-sm">
            <div class="bg-gray-800/60 rounded-lg p-3">
              <div class="text-xs text-indigo-400 mb-1">👤 主要人物（模型将重新生成形象）</div>
              <div class="text-gray-300 text-xs leading-relaxed">{{ analysis?.person || '—' }}</div>
            </div>
            <div class="bg-gray-800/60 rounded-lg p-3">
              <div class="text-xs text-indigo-400 mb-1">🌆 场景</div>
              <div class="text-gray-300 text-xs leading-relaxed">{{ analysis?.scene || '—' }}</div>
            </div>
            <div class="bg-gray-800/60 rounded-lg p-3">
              <div class="text-xs text-indigo-400 mb-1">💃 动作节奏</div>
              <div class="text-gray-300 text-xs leading-relaxed">{{ analysis?.motion || '—' }}</div>
            </div>
            <div class="bg-gray-800/60 rounded-lg p-3">
              <div class="text-xs text-indigo-400 mb-1">🎥 镜头 · BGM</div>
              <div class="text-gray-300 text-xs leading-relaxed">
                {{ analysis?.camera || '—' }}
                <span v-if="audioInfo.hasAudio" class="block mt-1 text-gray-500">
                  原片音频 ✓<template v-if="audioInfo.bpm">（约 {{ audioInfo.bpm }} BPM）</template>
                  · 生成的视频为 AI 音轨，需保留原 BGM 时下载后用剪映替换音轨
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 动作参考（火柴人） -->
        <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-sm font-medium">
              <span>🕺</span> 动作参考（火柴人）
            </div>
            <span class="text-xs" :class="{
              'text-indigo-400': poseState === 'running',
              'text-green-500': poseState === 'done',
              'text-yellow-600': poseState === 'error',
            }">
              {{ poseState === 'running' ? `提取中 ${poseProgress.done}/${poseProgress.total} 帧` : poseState === 'done' ? '✓ 动作已锁定，生成时随请求发送' : poseState === 'error' ? '提取失败，将用纯文字生成' : '' }}
            </span>
          </div>
          <div v-if="poseState === 'running'" class="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div class="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all"
              :style="{ width: poseProgress.total ? (poseProgress.done / poseProgress.total * 100).toFixed(1) + '%' : '5%' }"></div>
          </div>
          <video v-if="poseState === 'done' && stickman" :src="stickman.url" autoplay loop muted playsinline
            class="max-h-56 rounded-lg border border-gray-800 bg-black mx-auto block"></video>
          <p class="text-[11px] text-gray-600">从你的视频逐帧提取人体骨架渲染成火柴人演示（黑底白骨架），作为动作参考发给生成模型——动作节奏 100% 来自原视频，且不含真人画面。</p>
        </div>

        <!-- 提示词微调 -->
        <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
          <div class="text-sm font-medium flex items-center gap-2">
            <span class="w-6 h-6 rounded-full bg-purple-600 text-white text-xs flex items-center justify-center font-bold">3</span>
            提示词微调
          </div>

          <!-- 人物形象描述 -->
          <div>
            <label class="text-xs text-gray-500">人物形象描述（可选，留空 = 模型自行设计全新人物）</label>
            <textarea v-model="personDesc" rows="2" placeholder="例：金发年轻女性，穿白色运动套装；或：二次元动漫风少女，粉色双马尾"
              class="w-full mt-1 bg-gray-800 rounded-lg px-4 py-2 text-sm border border-gray-700 focus:border-indigo-500 focus:outline-none resize-none placeholder:text-gray-600"></textarea>
            <p class="text-[11px] text-gray-600 mt-1">提示词仅用于文字生成：视频只做分析参考不参与生成，动作按上面的文字描述重现，无需上传图片。</p>
          </div>

          <!-- 场景替换 -->
          <div>
            <label class="text-xs text-gray-500">场景（可修改）</label>
            <textarea v-model="sceneInput" rows="2"
              class="w-full mt-1 bg-gray-800 rounded-lg px-4 py-2 text-sm border border-gray-700 focus:border-indigo-500 focus:outline-none resize-none"></textarea>
          </div>

          <!-- 动作微调 -->
          <div>
            <label class="text-xs text-gray-500">动作要求（可修改，动作主体保留自原视频）</label>
            <textarea v-model="motionInput" rows="2"
              class="w-full mt-1 bg-gray-800 rounded-lg px-4 py-2 text-sm border border-gray-700 focus:border-indigo-500 focus:outline-none resize-none"></textarea>
          </div>

          <!-- 时长 + 成本预估 -->
          <div class="space-y-3">
            <div>
              <label class="text-xs text-gray-500">视频生成模型</label>
              <select v-model="genModel" class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700">
                <option v-for="m in GEN_MODELS" :key="m.id" :value="m.id">{{ m.label }}（¥{{ m.price.toFixed(1) }}/秒）</option>
              </select>
            </div>
            <div class="grid sm:grid-cols-2 gap-4">
              <div>
                <label class="text-xs text-gray-500">生成时长（≤ 原视频，上限 10 秒）</label>
                <select v-model.number="duration" class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700">
                  <option v-for="d in maxDuration" :key="d" :value="d" v-show="d >= 3">{{ d }}秒</option>
                </select>
              </div>
              <div class="rounded-lg border border-orange-900/60 bg-gradient-to-br from-orange-950/40 to-gray-900 p-3">
                <div class="flex justify-between text-xs text-gray-400"><span>单价（参考）</span><span>¥{{ currentModel.price.toFixed(2) }}/秒</span></div>
                <div class="flex justify-between text-xs text-gray-400 mt-1"><span>基础费用 {{ duration }}s</span><span>¥{{ cost.base.toFixed(2) }}</span></div>
                <div class="flex justify-between text-xs text-gray-500 mt-1"><span>重试预估 10%</span><span>¥{{ cost.retry.toFixed(2) }}</span></div>
                <div class="border-t border-gray-800 mt-2 pt-2 flex justify-between items-baseline">
                  <span class="text-gray-300 text-xs">预估总计</span>
                  <span class="text-xl font-bold text-orange-400">¥{{ cost.total.toFixed(2) }}</span>
                </div>
              </div>
            </div>
          </div>

          <button
            @click="generate" :disabled="!canGenerate"
            class="w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg font-medium text-white transition"
          >{{ busy === 'generating' ? '生成中…' : `🎬 开始生成（预估 ¥${cost.total.toFixed(2)}）` }}</button>
          <div class="text-xs text-gray-600 text-center">* 参考单价，实际以平台账单为准；人物形象由 AI 重新生成，不含真实人物<span v-if="stickman">；含火柴人动作参考，动作节奏来自你的原视频</span></div>
        </div>

        <!-- 轮询日志 -->
        <div v-if="pollLog.length" class="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <div class="text-xs text-gray-500 mb-2">任务进度</div>
          <div class="font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
            <div v-for="(log, i) in pollLog" :key="i" class="text-gray-400">{{ log }}</div>
          </div>
        </div>
      </div>

      <!-- ===== 步骤 3：结果 ===== -->
      <div v-if="step === 3" class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-3">
        <div class="flex items-center gap-2">
          <span class="w-6 h-6 rounded-full bg-green-600 text-white text-xs flex items-center justify-center font-bold">4</span>
          <span class="font-medium">生成结果</span>
        </div>
        <video :src="videoUrl" controls autoplay class="w-full rounded-lg"></video>
        <div class="flex flex-wrap items-center gap-3">
          <a :href="downloadHref" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition">⬇ 下载视频</a>
          <a :href="videoUrl" target="_blank" rel="noopener" class="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition">打开原链接</a>
          <button @click="restart" class="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition">🔄 换下一个</button>
          <span class="text-xs text-gray-500">保留原 BGM：下载后用剪映将原音轨贴回即可</span>
        </div>
      </div>
    </main>

    <!-- 动作脚本直出页签 -->
    <main v-else-if="tab === 'script'" class="max-w-4xl mx-auto px-6 py-8">
      <MotionScript />
    </main>

    <!-- FFmpeg 卡点图文页签 -->
    <main v-else class="max-w-4xl mx-auto px-6 py-8">
      <FfmpegBeat />
    </main>

    <!-- 人物图放大查看（已下线人物图功能，保留结构占位） -->

    <footer class="text-center text-xs text-gray-600 py-6">
      Powered by 火山方舟 Seedance · Key 安全存于服务端
    </footer>
  </div>
</template>
