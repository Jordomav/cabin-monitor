<script setup>
import { computed, ref } from 'vue'
import { useBaseStore } from '@/stores/baseStore'
import ConfirmModal from '@/components/ConfirmModal.vue'

const base = useBaseStore()
const power = computed(() => base.power)

// One modal, driven by a pending-action descriptor.
const pending = ref(null)
const ask = (action) => (pending.value = action)
function onConfirm() {
  const a = pending.value
  pending.value = null
  if (a) base.sendCommand(a.payload)
}

const GLOBAL_ACTIONS = [
  {
    label: 'Shutdown Low',
    title: 'Shut down low-priority farms?',
    body: 'Pauses all tier-4 (Low) farms.',
    confirmLabel: 'Shutdown Low',
    payload: { type: 'shutdown_priority', tier: 4 }
  },
  {
    label: 'Shutdown Med+',
    title: 'Shut down medium and lower farms?',
    body: 'Pauses all tier-3 (Medium) and below farms.',
    confirmLabel: 'Shutdown Med+',
    payload: { type: 'shutdown_priority', tier: 3 }
  },
  {
    label: 'Resume All',
    title: 'Resume all farms?',
    body: 'Clears overrides on every farm — automatic control resumes.',
    confirmLabel: 'Resume All',
    payload: { type: 'resume_all' }
  },
  {
    label: 'Shutdown All',
    title: 'Shut down EVERY farm?',
    body: 'Force-stops all farms including critical ones. Type CONFIRM.',
    confirmLabel: 'Shutdown All',
    requireText: 'CONFIRM',
    danger: true,
    payload: { type: 'shutdown_all' }
  }
]

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

    <div class="grid grid-cols-2 gap-2 mt-4 pt-3 border-t border-base-line">
      <button
        v-for="a in GLOBAL_ACTIONS"
        :key="a.label"
        class="text-xs py-2 rounded-lg border border-base-line active:bg-base-bg"
        :class="a.danger ? 'text-red-400 border-red-500/40' : 'text-gray-300'"
        @click="ask(a)"
      >
        {{ a.label }}
      </button>
    </div>

    <ConfirmModal
      v-if="pending"
      :title="pending.title"
      :body="pending.body"
      :confirm-label="pending.confirmLabel"
      :require-text="pending.requireText || null"
      :danger="!!pending.danger"
      @confirm="onConfirm"
      @cancel="pending = null"
    />
  </section>
</template>

