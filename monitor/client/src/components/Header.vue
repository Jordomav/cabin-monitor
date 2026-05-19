<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useBaseStore } from '@/stores/baseStore'

const props = defineProps({
  wsStatus: { type: String, default: 'connecting' }
})
defineEmits(['logout', 'open-settings'])

const base = useBaseStore()

// Tick once a second so "Ns ago" stays current without a new payload.
const now = ref(Date.now())
let timer
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => clearInterval(timer))

const live = computed(() => props.wsStatus === 'open')

const ago = computed(() => {
  if (!base.receivedAt) return 'no data yet'
  const s = Math.max(0, Math.round((now.value - base.receivedAt) / 1000))
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
        <span class="text-gray-500">· {{ ago }}</span>
      </p>
    </div>
    <div class="flex items-center gap-2">
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
