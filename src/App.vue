<script setup>
import { ref, computed } from 'vue'

// ====== 状态 ======
const tab = ref('text') // text | image
const prompt = ref('')
const imageUrl = ref('')
const model = ref('doubao-seedance-2-5-260628')
const duration = ref(5)
const ratio = ref('16:9')
const generateAudio = ref(true)
const watermark = ref(false)

const loading = ref(false)
const taskId = ref('')
const taskStatus = ref('')
const pollLog = ref([])
const videoUrl = ref('')
const errorMsg = ref('')

const models = [
  { id: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5（推荐）' },
  { id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0' },
  { id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast' },
  { id: 'doubao-seedance-2-0-mini-260615', label: 'Seedance 2.0 Mini' },
]

const ratios = ['16:9', '9:16', '1:1', 'adaptive']
const durations = [3, 5, 10]

const canGenerate = computed(() => {
  if (loading.value) return false
  if (tab.value === 'text') return prompt.value.trim().length > 0
  return imageUrl.value.trim().length > 0
})

// ====== API 调用（走 Vercel Functions 代理，key 在服务端） ======
async function callLocalAPI(path, body) {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`)
  return data
}

async function queryTask(id) {
  const resp = await fetch(`/api/task?task_id=${encodeURIComponent(id)}`)
  const data = await resp.json()
  if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`)
  return data
}

async function generate() {
  loading.value = true
  errorMsg.value = ''
  videoUrl.value = ''
  pollLog.value = []
  taskStatus.value = ''

  try {
    // 1. 创建任务
    const content = []
    if (tab.value === 'text' || (tab.value === 'image' && prompt.value.trim())) {
      content.push({ text: prompt.value, type: 'text' })
    }
    if (tab.value === 'image') {
      content.push({ image_url: { url: imageUrl.value }, type: 'image_url' })
    }

    const createData = await callLocalAPI('/api/generate', {
      model: model.value,
      content,
      duration: duration.value,
      ratio: ratio.value,
      generate_audio: generateAudio.value,
      watermark: watermark.value,
    })

    taskId.value = createData.task_id
    pollLog.value.push(`✓ 任务已创建：${taskId.value}`)

    // 2. 轮询
    const start = Date.now()
    while (true) {
      const elapsed = Math.floor((Date.now() - start) / 1000)
      if (elapsed > 600) throw new Error('超时（10分钟未完成）')

      const data = await queryTask(taskId.value)
      const status = data.status
      taskStatus.value = status
      pollLog.value.push(`[${elapsed}s] 状态：${status}`)

      if (status === 'succeeded') {
        const items = data.content || []
        for (const item of items) {
          if (item.video_url) { videoUrl.value = item.video_url; break }
          if (item.url && item.url.includes('http')) { videoUrl.value = item.url; break }
        }
        if (!videoUrl.value) throw new Error('任务成功但未找到视频 URL')
        pollLog.value.push('✓ 视频生成完成！')
        break
      }
      if (['failed', 'expired', 'canceled'].includes(status)) {
        throw new Error(`任务${status}：${JSON.stringify(data.error || '')}`)
      }
      await new Promise(r => setTimeout(r, 8000))
    }
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-gray-950 text-gray-100">
    <header class="border-b border-gray-800 px-6 py-4">
      <div class="max-w-4xl mx-auto">
        <h1 class="text-xl font-bold flex items-center gap-2">
          <span class="text-2xl">🎬</span> AI 视频生成器
          <span class="text-xs text-gray-500 font-normal ml-2">by Seedance</span>
        </h1>
      </div>
    </header>

    <main class="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <!-- Tab 切换 -->
      <div class="flex gap-2">
        <button
          @click="tab = 'text'"
          :class="tab === 'text' ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400'"
          class="px-4 py-2 rounded-lg text-sm font-medium transition"
        >文生视频</button>
        <button
          @click="tab = 'image'"
          :class="tab === 'image' ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400'"
          class="px-4 py-2 rounded-lg text-sm font-medium transition"
        >图生视频</button>
      </div>

      <!-- 输入区 -->
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
        <div v-if="tab === 'image'">
          <label class="text-sm text-gray-400">参考图片 URL</label>
          <input
            v-model="imageUrl" type="text"
            placeholder="https://example.com/image.png"
            class="w-full mt-1 bg-gray-800 rounded-lg px-4 py-2 text-sm border border-gray-700 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div>
          <label class="text-sm text-gray-400">
            {{ tab === 'text' ? '视频描述' : '附加提示词（可选）' }}
          </label>
          <textarea
            v-model="prompt" rows="3"
            :placeholder="tab === 'text' ? '一只橘猫在阳光窗台上打哈欠，特写镜头' : '女孩在海边奔跑'"
            class="w-full mt-1 bg-gray-800 rounded-lg px-4 py-2 text-sm border border-gray-700 focus:border-indigo-500 focus:outline-none resize-none"
          ></textarea>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <label class="text-xs text-gray-500">模型</label>
            <select v-model="model" class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700">
              <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-gray-500">时长</label>
            <select v-model="duration" class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700">
              <option v-for="d in durations" :key="d" :value="d">{{ d }}秒</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-gray-500">画幅</label>
            <select v-model="ratio" class="w-full mt-1 bg-gray-800 rounded-lg px-3 py-2 text-sm border border-gray-700">
              <option v-for="r in ratios" :key="r" :value="r">{{ r }}</option>
            </select>
          </div>
          <div class="flex flex-col justify-end gap-2">
            <label class="flex items-center gap-2 text-xs text-gray-400">
              <input type="checkbox" v-model="generateAudio" class="accent-indigo-500" /> 生成音频
            </label>
            <label class="flex items-center gap-2 text-xs text-gray-400">
              <input type="checkbox" v-model="watermark" class="accent-indigo-500" /> 水印
            </label>
          </div>
        </div>

        <button
          @click="generate" :disabled="!canGenerate"
          class="w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg font-medium text-white transition"
        >{{ loading ? '生成中…' : '🎬 生成视频' }}</button>
      </div>

      <!-- 错误 -->
      <div v-if="errorMsg" class="bg-red-950/50 border border-red-800 rounded-xl p-4 text-sm text-red-300">
        ⚠ {{ errorMsg }}
      </div>

      <!-- 轮询日志 -->
      <div v-if="pollLog.length" class="bg-gray-900 rounded-xl p-4 border border-gray-800">
        <div class="text-xs text-gray-500 mb-2">任务进度</div>
        <div class="font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
          <div v-for="(log, i) in pollLog" :key="i" class="text-gray-400">{{ log }}</div>
        </div>
      </div>

      <!-- 视频结果 -->
      <div v-if="videoUrl" class="bg-gray-900 rounded-xl p-5 border border-gray-800">
        <div class="text-sm text-gray-400 mb-3">生成结果</div>
        <video :src="videoUrl" controls autoplay class="w-full rounded-lg"></video>
        <a :href="videoUrl" download="ai-video.mp4" class="inline-block mt-3 text-sm text-indigo-400 hover:underline">
          ⬇ 下载视频
        </a>
      </div>
    </main>

    <footer class="text-center text-xs text-gray-600 py-6">
      Powered by 火山方舟 Seedance · Key 安全存于服务端
    </footer>
  </div>
</template>
