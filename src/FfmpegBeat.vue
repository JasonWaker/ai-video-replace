<script setup>
import { ref, computed, watch } from 'vue'
import PromptPicker from './PromptPicker.vue'

// 接收 App.vue 共享的视频
const props = defineProps({
  videoFile: { type: Object, default: null },
  videoDuration: { type: Number, default: 0 },
  videoW: { type: Number, default: 0 },
  videoH: { type: Number, default: 0 },
})

// ====== 状态 ======
const step = ref(1) // 1 参数 | 2 生图+合成 | 3 结果
const busy = ref('')
const errorMsg = ref('')

// 鼓点
const beats = ref([]) // 鼓点时间戳秒
const bpmEst = ref(0)

// 人物设定
const personPrompt = ref('')
const scenePrompt = ref('')
const shotCount = ref(8) // 生成几张图

// 生成的图片
const images = ref([]) // [{url, blobUrl, img}]
const imageProgress = ref({ done: 0, total: 0 })
const imagesReady = ref(false)

// 合成结果
const outputBlob = ref(null)
const outputUrl = ref('')
const outputExt = ref('mp4')
const synthProgress = ref(0)

const isVertical = computed(() => props.videoH >= props.videoW)
const canGenImages = computed(() => !!props.videoFile && !!personPrompt.value.trim() && !busy.value)

// watch 共享视频，自动检测鼓点
watch(() => props.videoFile, async (file) => {
  if (file && step.value === 1) {
    await detectBeats(file)
  }
}, { immediate: true })

// ====== 工具 ======
async function postJSON(path, body) {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${resp.status}`)
  return data
}

// 从视频文件解码 AudioBuffer（用于鼓点检测 + 后续合成）
async function decodeAudio(file) {
  const AC = window.AudioContext || window.webkitAudioContext
  const ctx = new AC()
  const buf = await ctx.decodeAudioData(await file.arrayBuffer())
  ctx.close()
  return buf
}

// 自动检测鼓点（watch videoFile 时调用）
async function detectBeats(file) {
  busy.value = 'detecting'
  try {
    const audioBuf = await decodeAudio(file)
    const data = audioBuf.getChannelData(0)
    const hop = 512
    const env = []
    for (let i = 0; i + hop < data.length; i += hop) {
      let s = 0
      for (let j = 0; j < hop; j++) s += data[i + j] * data[i + j]
      env.push(Math.sqrt(s / hop))
    }
    const mean = env.reduce((a, b) => a + b, 0) / env.length
    const thr = mean * 1.4
    const peaks = []
    const minGapIdx = Math.round(0.25 * (audioBuf.sampleRate / hop))
    for (let i = 1; i < env.length - 1; i++) {
      if (env[i] > thr && env[i] >= env[i - 1] && env[i] >= env[i + 1]) {
        if (!peaks.length || i - peaks[peaks.length - 1] >= minGapIdx) peaks.push(i)
      }
    }
    beats.value = peaks.map(p => (p * hop) / audioBuf.sampleRate)
    if (beats.value.length >= 4) {
      const gaps = []
      for (let i = 1; i < beats.value.length; i++) gaps.push(beats.value[i] - beats.value[i - 1])
      gaps.sort((a, b) => a - b)
      const med = gaps[Math.floor(gaps.length / 2)]
      bpmEst.value = Math.round(60 / med)
    }
  } catch (e) {
    errorMsg.value = '鼓点检测失败：' + e.message
  } finally {
    busy.value = ''
  }
}

// 8 个姿势变体（按顺序轮换）
const POSES = [
  '正对镜头微笑站立',
  '侧身回头看向镜头',
  '右手轻撩头发',
  '双手叉腰挺拔站立',
  '单手比心',
  '转头看向侧方微笑',
  '近景特写看向镜头',
  '远景全身自然站立',
]

// 批量生图
async function generateImages() {
  busy.value = 'imaging'
  errorMsg.value = ''
  imageProgress.value = { done: 0, total: shotCount.value }
  images.value = []
  imagesReady.value = false
  try {
    // 鼓点已经在 watch videoFile 时检测过了；不足则用等间隔补
    if (beats.value.length < shotCount.value) {
      const dur = props.videoDuration || 10
      const step = dur / shotCount.value
      beats.value = Array.from({ length: shotCount.value }, (_, i) => +(i * step).toFixed(2))
    }
    beats.value = beats.value.slice(0, shotCount.value)
    // 让最后一个鼓点落在视频结尾前
    if (beats.value[beats.value.length - 1] > videoDuration.value - 0.5) {
      beats.value[beats.value.length - 1] = videoDuration.value - 0.3
    }

    // 2) 批量调 Seedream：第1张正常生成定妆图，后续以第1张为参考保持一致
    const baseScene = scenePrompt.value.trim() || '高端度假酒店泳池边傍晚，暖金色夕阳'
    let refImageUrl = '' // 第1张图的原始 URL，作为后续图生图参考
    for (let i = 0; i < shotCount.value; i++) {
      const pose = POSES[i % POSES.length]
      let prompt
      if (i === 0) {
        prompt = `写实人像摄影，9:16竖屏，中全景，${personPrompt.value.trim()}，${baseScene}，${pose}，皮肤通透，高清细腻，电影感光线，无文字无水印`
      } else {
        // 图生图：强制保持人物、服装、场景一致，只改姿势
        prompt = `保持参考图中的人物长相、发型、服装款式颜色、场景、光线完全一致，只改变人物姿势为：${pose}。写实摄影，9:16竖屏，中全景，高清细腻，无文字无水印`
      }
      try {
        const data = await postJSON('/api/seedream', {
          prompt,
          size: '1080x1920',
          ...(refImageUrl ? { image: refImageUrl } : {}),
        })
        if (i === 0) refImageUrl = data.image_url
        // 走代理拿 blob（避免 CORS 污染 canvas）
        const imgResp = await fetch(`/api/download?url=${encodeURIComponent(data.image_url)}&filename=shot${i}.jpg`)
        const blob = await imgResp.blob()
        const blobUrl = URL.createObjectURL(blob)
        const img = new Image()
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = blobUrl })
        images.value.push({ url: data.image_url, blobUrl, img })
      } catch (e) {
        errorMsg.value = `第 ${i + 1} 张生成失败：${e.message}（已跳过）`
      }
      imageProgress.value = { done: i + 1, total: shotCount.value }
    }
    if (!images.value.length) throw new Error('所有图片生成失败')
    imagesReady.value = true
    step.value = 2
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    busy.value = ''
  }
}

// ====== Canvas 合成 ======
async function renderVideo() {
  busy.value = 'rendering'
  errorMsg.value = ''
  synthProgress.value = 0
  try {
    const audioBuf = await decodeAudio()
    const W = isVertical.value ? 720 : 1280
    const H = isVertical.value ? 1280 : 720
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    const fps = 30

    // 音频接入
    const AC = window.AudioContext || window.webkitAudioContext
    const actx = new AC()
    const src = actx.createBufferSource()
    src.buffer = audioBuf
    const audioDest = actx.createMediaStreamDestination()
    src.connect(audioDest)

    // 视频流 + 音频流合并
    const vstream = canvas.captureStream(fps)
    const stream = new MediaStream([
      ...vstream.getVideoTracks(),
      ...audioDest.getAudioTracks(),
    ])

    const mime = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      .find(m => window.MediaRecorder?.isTypeSupported?.(m)) || ''
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 5000000 } : undefined)
    const chunks = []
    rec.ondataavailable = e => e.data.size && chunks.push(e.data)
    const stopped = new Promise(r => (rec.onstop = r))

    // 绘制函数：根据时间 t 画当前图 + Ken Burns
    function drawAt(t) {
      // 找到当前应该显示第几张图
      let idx = 0
      for (let i = 0; i < beats.value.length; i++) {
        if (t >= beats.value[i]) idx = i
      }
      idx = Math.min(idx, images.value.length - 1)
      const img = images.value[idx].img

      // 当前图持续区间
      const tStart = beats.value[idx] || 0
      const tEnd = beats.value[idx + 1] ?? videoDuration.value
      const localT = Math.max(0, Math.min(1, (t - tStart) / Math.max(0.001, tEnd - tStart)))

      // Ken Burns：缓慢放大 1.0 → 1.12
      const scale = 1.0 + localT * 0.12
      // cover 模式铺满
      const iw = img.width, ih = img.height
      const imgRatio = iw / ih, canvasRatio = W / H
      let dw, dh
      if (imgRatio > canvasRatio) { dh = H; dw = H * imgRatio } else { dw = W; dh = W / imgRatio }
      dw *= scale; dh *= scale
      const dx = (W - dw) / 2
      const dy = (H - dh) / 2

      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)
      ctx.drawImage(img, dx, dy, dw, dh)

      // 切换瞬间 80ms 闪白
      if (idx > 0 && t - beats.value[idx] < 0.08) {
        const a = 1 - (t - beats.value[idx]) / 0.08
        ctx.fillStyle = `rgba(255,255,255,${a * 0.7})`
        ctx.fillRect(0, 0, W, H)
      }
    }

    // 开始录制
    src.start(0)
    rec.start()
    const totalFrames = Math.floor(videoDuration.value * fps)
    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps
      drawAt(t)
      synthProgress.value = Math.round((f / totalFrames) * 100)
      // 等待到实际时间
      // 因为是离线渲染，不用 real-time 等待，但为了让 MediaRecorder 抓到帧，我们用小 sleep
      await new Promise(r => setTimeout(r, 1000 / fps))
    }
    await new Promise(r => setTimeout(r, 300))
    rec.stop()
    src.stop()
    src.disconnect()
    audioDest.disconnect()
    actx.close()
    await stopped

    const type = rec.mimeType || mime || 'video/webm'
    outputExt.value = type.includes('mp4') ? 'mp4' : 'webm'
    outputBlob.value = new Blob(chunks, { type })
    outputUrl.value = URL.createObjectURL(outputBlob.value)
    step.value = 3
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    busy.value = ''
  }
}

function resetAll() {
  step.value = 1
  beats.value = []
  bpmEst.value = 0
  images.value.forEach(i => URL.revokeObjectURL(i.blobUrl))
  images.value = []
  imagesReady.value = false
  outputBlob.value = null
  if (outputUrl.value) URL.revokeObjectURL(outputUrl.value)
  outputUrl.value = ''
  synthProgress.value = 0
  errorMsg.value = ''
}
</script>

<template>
  <div class="space-y-6">
    <div class="bg-gradient-to-r from-orange-950/40 to-amber-950/30 border border-orange-800/50 rounded-xl p-4 text-xs text-orange-200/80 leading-relaxed">
      ⚡ <b>FFmpeg 卡点图文视频</b>：不调视频生成模型。用 Seedream 生成 N 张不同姿势的图 → Canvas 按 BGM 鼓点切图 + Ken Burns 缓慢缩放 + 闪白转场 → 直出带 BGM 的成片。<b>单条成本 ≈ ¥0.2×N，过审率 100%</b>，适合批量起号。
    </div>

    <div v-if="errorMsg" class="bg-red-950/50 border border-red-800 rounded-xl p-4 text-sm text-red-300 whitespace-pre-line">
      ⚠ {{ errorMsg }}
    </div>

    <!-- Step 1: 参数（用顶部共享的视频自动检测鼓点） -->
    <div v-if="step === 1" class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
      <div class="flex items-center gap-2">
        <span class="w-6 h-6 rounded-full bg-orange-600 text-white text-xs flex items-center justify-center font-bold">1</span>
        <span class="font-medium">参数设置</span>
        <span class="text-xs text-gray-500">鼓点自动从顶部共享视频检测</span>
      </div>
      <div v-if="!props.videoFile" class="text-sm text-gray-500 py-2 text-center">
        请先在上方公共区上传带音乐的视频
      </div>
      <div v-else class="text-xs text-orange-300">
        ✓ 已检测 {{ beats.length }} 个鼓点<template v-if="bpmEst"> · 约 {{ bpmEst }} BPM</template>
        <span v-if="busy === 'detecting'">，检测中…</span>
      </div>

      <div class="grid sm:grid-cols-2 gap-3 pt-2">
        <div>
          <label class="text-xs text-gray-500 flex items-center gap-2">人物形象描述
            <PromptPicker v-model="personPrompt" />
          </label>
          <textarea v-model="personPrompt" rows="2" placeholder="例：两位年轻东亚女性，齐肩短发和长卷发，穿香槟色亮片裙"
            class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700 focus:border-orange-500 focus:outline-none resize-none"></textarea>
        </div>
        <div>
          <label class="text-xs text-gray-500 flex items-center gap-2">场景（每张图共用）
            <PromptPicker v-model="scenePrompt" />
          </label>
          <textarea v-model="scenePrompt" rows="2" placeholder="高端度假酒店无边泳池傍晚，暖金色夕阳"
            class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700 focus:border-orange-500 focus:outline-none resize-none"></textarea>
        </div>
      </div>

      <div>
        <label class="text-xs text-gray-500">生成图片数（= 切换次数，约 ¥0.2/张）</label>
        <input v-model.number="shotCount" type="range" min="4" max="16" class="w-full mt-1 accent-orange-500"/>
        <div class="text-xs text-orange-400 mt-1">{{ shotCount }} 张 ≈ ¥{{ (shotCount * 0.2).toFixed(1) }}</div>
      </div>

      <button @click="generateImages" :disabled="!canGenImages"
        class="w-full py-3 bg-gradient-to-r from-orange-600 to-amber-600 disabled:opacity-40 rounded-lg font-medium text-white">
        {{ busy === 'imaging' ? `生成图片中 ${imageProgress.done}/${imageProgress.total}…` : '🎨 生成图片并检测鼓点' }}
      </button>
    </div>

    <!-- Step 2: 预览图 + 合成 -->
    <div v-if="step === 2" class="space-y-6">
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="w-6 h-6 rounded-full bg-orange-600 text-white text-xs flex items-center justify-center font-bold">2</span>
            <span class="font-medium">图片预览（{{ images.length }}/{{ shotCount }}）</span>
          </div>
          <span class="text-xs text-gray-500">检测到鼓点 {{ beats.length }} 个<template v-if="bpmEst"> · 约 {{ bpmEst }} BPM</template></span>
        </div>
        <div class="grid grid-cols-4 gap-2">
          <div v-for="(img, i) in images" :key="i" class="space-y-1">
            <img :src="img.blobUrl" class="w-full rounded border border-gray-700 aspect-[9/16] object-cover"/>
            <div class="text-[10px] text-gray-500 text-center">{{ beats[i]?.toFixed(1) }}s · {{ i + 1 }}</div>
          </div>
        </div>
      </div>

      <button @click="renderVideo" :disabled="busy === 'rendering'"
        class="w-full py-3 bg-gradient-to-r from-orange-600 to-amber-600 disabled:opacity-40 rounded-lg font-medium text-white">
        {{ busy === 'rendering' ? `合成中 ${synthProgress}%…` : `⚡ 合成视频（${videoDuration.toFixed(1)}s，实时渲染）` }}
      </button>
    </div>

    <!-- Step 3: 结果 -->
    <div v-if="step === 3" class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-3">
      <div class="flex items-center gap-2">
        <span class="w-6 h-6 rounded-full bg-green-600 text-white text-xs flex items-center justify-center font-bold">✓</span>
        <span class="font-medium">成片</span>
      </div>
      <video :src="outputUrl" controls autoplay class="w-full rounded-lg"></video>
      <div class="text-xs text-gray-500">时长 {{ videoDuration.toFixed(1) }}s · {{ images.length }} 个切换 · 带原 BGM</div>
      <div class="flex gap-3">
        <a :href="outputUrl" :download="'beat-video.' + outputExt"
          class="px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded-lg text-sm">⬇ 下载 ({{ outputExt }})</a>
        <button @click="resetAll" class="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm">🔄 下一条</button>
      </div>
    </div>
  </div>
</template>
