<script setup>
import { ref, computed, onMounted } from 'vue'

// ====== 状态 ======
const apiKey = ref(localStorage.getItem('ark_api_key') || '')
const showKeyInput = ref(!apiKey.value)
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
  if (!apiKey.value || loading.value) return false
  if (tab.value === 'text') return prompt.value.trim().length > 0
  return imageUrl.value.trim().length > 0
})

// ====== API 调用 ======
const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3'

async function createTask() {
  const content = []
  if (tab.value === 'text' || (tab.value === 'image' && prompt.value.trim())) {
    content.push({ text: prompt.value, type: 'text' })
  }
  if (tab.value === 'image') {
    content.push({ image_url: { url: imageUrl.value }, type: 'image_url' })
  }

  const body = {
    model: model.value,
    content,
    duration: duration.value,
    ratio: ratio.value,
    generate_audio: generateAudio.value,
    watermark: watermark.value,
  }

  const resp = await fetch(`${ARK_BASE}/contents/generations/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey.value}`,
    },
    body: JSON.stringify(body),
  })

  const data = await resp.json()
  if (!resp.ok) {
    throw new Error(data?.error?.message || `HTTP ${resp.status}`)
  }
  return data.id
}

async function pollTask(id) {
  const start = Date.now()
  while (true) {
    const elapsed = Math.floor((Date.now() - start) / 1000)
    if (elapsed > 600) throw new Error('超时（10分钟未完成）')

    const resp = await fetch(`${ARK_BASE}/contents/generations/tasks/${id}`, {
      headers: { 'Authorization': `Bearer ${apiKey.value}` },
    })
    const data = await resp.json()
    if (!resp.ok) throw new Error(data?.error?.message || `HTTP ${resp.status}`)

    const status = data.status
    taskStatus.value = status
    pollLog.value.push(`[${elapsed}s] 状态：${status}`)

    if (status === 'succeeded') {
      // 从 content 里找视频 URL
      const content = data.content || []
      for (const item of content) {
        if (item.video_url) return item.video_url
        if (item.url && item.url.includes('http')) return item.url
      }
      throw new Error('任务成功但未找到视频 URL')
    }
    if (['failed', 'expired', 'canceled'].includes(status)) {
      throw new Error(`任务${status}：${JSON.stringify(data.error || '')}`)
    }
    await new Promise(r => setTimeout(r, 8000))
  }
}

async function generate() {
  loading.value = true
  errorMsg.value = ''
  videoUrl.value = ''
  pollLog.value = []
  taskStatus.value = ''

  try {
    taskId.value = await createTask()
    pollLog.value.push(`✓ 任务已创建：${taskId.value}`)
    const url = await pollTask(taskId.value)
    videoUrl.value = url
    pollLog.value.push('✓ 视频生成完成！')
  } catch (e) {
    errorMsg.value = e.message
    // CORS 错误特殊提示
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      errorMsg.value = '网络请求失败——可能是浏览器跨域(CORS)限制。请用本地代理模式运行：npm run dev'
    }
  } finally {
    loading.value = false
  }
}

function saveKey() {
  localStorage.setItem('ark_api_key', apiKey.value)
  showKeyInput.value = false
}

function clearKey() {
  localStorage.removeItem('ark_api_key')
  apiKey.value = ''
  showKeyInput.value = true
}

onMounted(() => {
  if (!apiKey.value) showKeyInput.value = true
})
</script>

<template>
  <div class="min-h-screen bg-gray-950 text-gray-100">
    <!-- 顶栏 -->
    <header class="border-b border-gray-800 px-6 py-4">
      <div class="max-w-4xl mx-auto flex items-center justify-between">
        <h1 class="text-xl font-bold flex items-center gap-2">
          <span class="text-2xl">🎬</span> AI 视频生成器
        </h1>
        <button
          v-if="apiKey"
          @click="showKeyInput = !showKeyInput"
          class="text-sm text-gray-400 hover:text-gray-200"
        >
          {{ showKeyInput ? '收起' : 'API Key 设置' }}
        </button>
      </div>
    </header>

    <main class="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <!-- API Key 输入 -->
      <div v-if="showKeyInput" class="bg-gray-900 rounded-xl p-5 border border-gray-800">
        <h2 class="text-sm font-medium text-gray-300 mb-3">火山方舟 API Key</h2>
        <div class="flex gap-3">
          <input
            v-model="apiKey"
            type="password"
            placeholder="ark-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            class="flex-1 bg-gray-800 rounded-lg px-4 py-2 text-sm border border-gray-700 focus:border-indigo-500 focus:outline-none"
          />
          <button
            @click="saveKey"
            :disabled="!apiKey"
            class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg text-sm font-medium"
          >
            保存
          </button>
        </div>
        <p class="text-xs text-gray-500 mt-2">
          Key 仅存储在浏览器 localStorage，不会上传到任何服务器。
          <a href="https://console.volcengine.com/ark/region:ark+cn-beijing/apikey" target="_blank" class="text-indigo-400 hover:underline">获取 API Key →</a>
        </p>
      </div>

      <!-- 主面板 -->
      <div v-if="apiKey && !showKeyInput" class="space-y-6">
        <!-- Tab 切换 -->
        <div class="flex gap-2">
          <button
            @click="tab = 'text'"
            :class="tab === 'text' ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400'"
            class="px-4 py-2 rounded-lg text-sm font-medium transition"
          >
            文生视频
          </button>
          <button
            @click="tab = 'image'"
            :class="tab === 'image' ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400'"
            class="px-4 py-2 rounded-lg text-sm font-medium transition"
          >
            图生视频
          </button>
        </div>

        <!-- 输入区 -->
        <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
          <!-- 图生视频：图片URL -->
          <div v-if="tab === 'image'">
            <label class="text-sm text-gray-400">参考图片 URL</label>
            <input
              v-model="imageUrl"
              type="text"
              placeholder="https://example.com/image.png"
              class="w-full mt-1 bg-gray-800 rounded-lg px-4 py-2 text-sm border border-gray-700 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <!-- 提示词 -->
          <div>
            <label class="text-sm text-gray-400">
              {{ tab === 'text' ? '视频描述' : '附加提示词（可选）' }}
            </label>
            <textarea
              v-model="prompt"
              rows="3"
              :placeholder="tab === 'text' ? '一只橘猫在阳光窗台上打哈欠，特写镜头' : '女孩在海边奔跑'"
              class="w-full mt-1 bg-gray-800 rounded-lg px-4 py-2 text-sm border border-gray-700 focus:border-indigo-500 focus:outline-none resize-none"
            ></textarea>
          </div>

          <!-- 参数 -->
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
                <input type="checkbox" v-model="generateAudio" class="accent-indigo-500" /> 音频
              </label>
              <label class="flex items-center gap-2 text-xs text-gray-400">
                <input type="checkbox" v-model="watermark" class="accent-indigo-500" /> 水印
              </label>
            </div>
          </div>

          <!-- 生成按钮 -->
          <button
            @click="generate"
            :disabled="!canGenerate"
            class="w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg font-medium text-white transition"
          >
            {{ loading ? '生成中…' : '🎬 生成视频' }}
          </button>
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
          <video
            :src="videoUrl"
            controls
            autoplay
            class="w-full rounded-lg"
          ></video>
          <a
            :href="videoUrl"
            download="ai-video.mp4"
            class="inline-block mt-3 text-sm text-indigo-400 hover:underline"
          >⬇ 下载视频</a>
        </div>
      </div>
    </main>

    <footer class="text-center text-xs text-gray-600 py-6">
      Powered by 火山方舟 Seedance · API Key 存储于浏览器本地
    </footer>
  </div>
</template>
