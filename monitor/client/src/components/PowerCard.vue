<script setup>
import { computed } from 'vue'
import { useBaseStore } from '@/stores/baseStore'

const base = useBaseStore()
const power = computed(() => base.power)

// NORMAL / WARNING / CRITICAL — colour the whole card by state.
const theme = computed(() => {
  switch (power.value?.state) {
    case 'CRITICAL':
      return { ring: 'border-red-500/60', text: 'text-red-400', bar: 'bg-red-500', dot: '🔴' }
    case 'WARNING':
      return { ring: 'border-amber-500/60', text: 'text-amber-400', bar: 'bg-amber-500', dot: '🟠' }
    default:
      return { ring: 'border-emerald-500/50', text: 'text-emerald-400', bar: 'bg-emerald-500', dot: '🟢' }
  }
})

const loadPct = computed(() => {
  const r = power.value?.ratio
  if (typeof r !== 'number') return 0
  return Math.min(100, Math.max(0, Math.round(r * 100)))
})

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : '—')
</script>

<template>
  <section
    class="bg-base-card border rounded-2xl p-4"
    :class="theme.ring"
  >
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-semibold text-gray-300">⚡ POWER</h2>
      <span class="text-sm font-semibold" :class="theme.text">
        {{ theme.dot }} {{ power?.state || 'NO DATA' }}
      </span>
    </div>

    <template v-if="power">
      <div class="mt-3">
        <div class="flex justify-between text-xs text-gray-400 mb-1">
          <span>Load</span>
          <span>{{ loadPct }}%</span>
        </div>
        <div class="h-2.5 rounded-full bg-base-bg overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-500"
            :class="theme.bar"
            :style="{ width: loadPct + '%' }"
          />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2 mt-3 text-sm">
        <div>
          <p class="text-xs text-gray-500">Generation</p>
          <p class="font-medium">{{ fmt(power.generation) }} SU</p>
        </div>
        <div>
          <p class="text-xs text-gray-500">Consumption</p>
          <p class="font-medium">{{ fmt(power.consumption) }} SU</p>
        </div>
      </div>
    </template>

    <p v-else class="text-sm text-gray-500 mt-3">Awaiting first report…</p>
  </section>
</template>
