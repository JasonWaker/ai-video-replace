<script setup>
import { ref } from 'vue'
import { PROMPT_LIBRARY } from './prompt-library.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const open = ref(false)
function pick(word) {
  const cur = (props.modelValue || '').trim()
  // 已有内容：用逗号连接；没有就直接填
  emit('update:modelValue', cur ? `${cur}，${word}` : word)
}
</script>

<template>
  <span class="relative inline-block">
    <button
      type="button"
      @click.stop="open = !open"
      class="text-xs px-2 py-0.5 rounded bg-amber-900/40 text-amber-300 hover:bg-amber-800/50 border border-amber-800/50 transition"
      title="打开提示词库"
    >💡 词库</button>

    <div v-if="open" @click.stop
      class="absolute z-50 left-0 mt-2 w-80 max-h-96 overflow-y-auto bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-2xl">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs text-gray-400">点击词追加到输入框</span>
        <button @click="open = false" class="text-xs text-gray-500 hover:text-gray-300">✕</button>
      </div>
      <div v-for="cat in PROMPT_LIBRARY" :key="cat.category" class="mb-2">
        <div class="text-[11px] text-amber-400 font-medium mb-1">{{ cat.category }}</div>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="w in cat.words" :key="w"
            @click="pick(w)"
            class="text-[11px] px-2 py-0.5 rounded bg-gray-800 hover:bg-indigo-700 text-gray-300 border border-gray-700 transition"
          >{{ w }}</button>
        </div>
      </div>
    </div>
  </span>
</template>
