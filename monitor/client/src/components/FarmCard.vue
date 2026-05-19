<script setup>
import { computed } from 'vue'

// `farm` is a farms.json entry merged with a `.status` field (live or null).
const props = defineProps({
  farm: { type: Object, required: true }
})

const status = computed(() => props.farm.status)

const badge = computed(() => {
  const s = status.value
  if (!s || s.online === false) return { text: 'OFFLINE', cls: 'bg-gray-600 text-gray-200' }
  if (s.override) return { text: 'OVERRIDE', cls: 'bg-orange-600 text-white' }
  if (s.running) return { text: 'RUNNING', cls: 'bg-emerald-600 text-white' }
  return { text: 'PAUSED', cls: 'bg-red-600 text-white' }
})

const offline = computed(() => !status.value || status.value.online === false)
const fill = computed(() =>
  typeof status.value?.fill === 'number' ? status.value.fill : null
)

const barColor = computed(() => {
  if (fill.value === null) return 'bg-gray-700'
  if (fill.value >= props.farm.high_threshold) return 'bg-red-500'
  if (fill.value >= 60) return 'bg-amber-500'
  return 'bg-emerald-500'
})
</script>

<template>
  <div
    class="bg-base-bg border border-base-line rounded-xl p-3"
    :class="{ 'opacity-60': offline }"
  >
    <div class="flex items-center justify-between gap-2">
      <span class="font-medium text-sm truncate">{{ farm.label }}</span>
      <span
        class="text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0"
        :class="badge.cls"
      >
        {{ badge.text }}
      </span>
    </div>

    <div class="mt-2 flex items-center gap-2">
      <div class="flex-1 h-2 rounded-full bg-base-card overflow-hidden">
        <div
          class="h-full rounded-full transition-all duration-500"
          :class="barColor"
          :style="{ width: (fill ?? 0) + '%' }"
        />
      </div>
      <span class="text-xs tabular-nums w-10 text-right text-gray-400">
        {{ fill === null ? '—' : fill + '%' }}
      </span>
    </div>
  </div>
</template>
