<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useBaseStore } from '@/stores/baseStore'

const props = defineProps({
  wsStatus: { type: String, default: 'connecting' }
})
defineEmits(['logout', 'open-settings', 'open-manage'])

const base = useBaseStore()

// Tick once a second so "Ns ago" stays current without a new payload.
const now = ref(Date.now())
let timer
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => clearInterval(timer))

const live = computed(() => props.wsStatus === 'open')

// Data is "stale" once it hasn't been refreshed within roughly the central
// post interval + report timeout. Past 60s without a payload, treat it as
// disconnected even if the WS still claims to be open.
const ageSec = computed(() => {
  if (!base.receivedAt) return null
  return Math.max(0, Math.round((now.value - base.receivedAt) / 1000))
})
const freshness = computed(() => {
  const s = ageSec.value
  if (s === null) return 'none'
  if (s < 10) return 'fresh'
  if (s < 30) return 'stale'
  return 'down'
})
const freshnessClass = computed(
  () =>
    ({
      fresh: 'text-gray-500',
      stale: 'text-amber-400',
      down: 'text-red-400',
      none: 'text-gray-500'
    }[freshness.value])
)

const ago = computed(() => {
  const s = ageSec.value
  if (s === null) return 'no data yet'
  if (s < 60) return `${s}s ago`
  return `${Math.floor(s / 60)}m ago`
})
</script>

<template>
  <header
    class="sticky top-0 z-10 bg-base-bg/95 backdrop-blur border-b border-base-line
           px-3 py-3 flex items-center justify-between"
  >
    <div>
      <h1 class="text-base font-semibold leading-tight">🏠 CABIN Base Monitor</h1>
      <p class="text-xs mt-0.5 flex items-center gap-1.5">
        <span :class="live ? 'text-emerald-400' : 'text-amber-400'">
          {{ live ? '🟢 Live' : '🟠 ' + wsStatus }}
        </span>
        <span :class="freshnessClass">· {{ ago }}</span>
        <span
          v-if="freshness === 'down'"
          class="ml-1 text-[10px] font-semibold text-red-300 bg-red-900/40 px-1.5 py-0.5 rounded"
        >
          STALE
        </span>
      </p>
    </div>
    <div class="flex items-center gap-2">
      <button
        class="text-base border border-base-line rounded-lg px-2.5 py-1.5
               active:bg-base-card"
        aria-label="Manage farms"
        @click="$emit('open-manage')"
      >
        🛠
      </button>
      <button
        class="text-base border border-base-line rounded-lg px-2.5 py-1.5
               active:bg-base-card"
        aria-label="Notification settings"
        @click="$emit('open-settings')"
      >
        ⚙️
      </button>
      <button
        class="text-xs text-gray-400 active:text-gray-200 border border-base-line
               rounded-lg px-3 py-1.5"
        @click="$emit('logout')"
      >
        Log out
      </button>
    </div>
  </header>
</template>
