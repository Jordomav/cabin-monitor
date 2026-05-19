<script setup>
import { onMounted, watch, ref, shallowRef } from 'vue'
import { storeToRefs } from 'pinia'
import { useAuthStore } from '@/stores/authStore'
import { useWebSocket } from '@/composables/useWebSocket'
import LoginPage from '@/components/LoginPage.vue'

const auth = useAuthStore()
const { authenticated, checking } = storeToRefs(auth)

// WebSocket is only started once authenticated (server gates the upgrade on
// the session cookie). The full dashboard wiring lands in Milestone 3.
const wsStatus = ref('connecting')
const lastMessage = shallowRef(null)
let socket = null

function startSocket() {
  if (socket) return
  socket = useWebSocket((msg) => {
    lastMessage.value = msg
  })
  watch(socket.status, (s) => (wsStatus.value = s), { immediate: true })
}

watch(
  authenticated,
  (isAuthed) => {
    if (isAuthed) {
      startSocket()
    } else if (socket) {
      socket.close()
      socket = null
    }
  },
  { immediate: true }
)

onMounted(auth.checkSession)
</script>

<template>
  <div v-if="checking" class="min-h-screen flex items-center justify-center text-gray-500">
    Loading…
  </div>

  <LoginPage v-else-if="!authenticated" />

  <div v-else class="min-h-screen p-4">
    <header class="flex items-center justify-between mb-4">
      <h1 class="text-base font-semibold">🏠 CABIN Base Monitor</h1>
      <button class="text-sm text-gray-400 active:text-gray-200" @click="auth.logout">
        Log out
      </button>
    </header>

    <div class="bg-base-card border border-base-line rounded-2xl p-6 text-center space-y-2">
      <p class="text-emerald-400">✅ Authenticated — dashboard scaffold</p>
      <p class="text-sm text-gray-400">
        WebSocket:
        <span :class="wsStatus === 'open' ? 'text-emerald-400' : 'text-amber-400'">
          {{ wsStatus }}
        </span>
      </p>
      <p class="text-xs text-gray-500">
        Live data display arrives in Milestone 3.
      </p>
      <pre
        v-if="lastMessage"
        class="text-left text-xs text-gray-400 overflow-x-auto mt-2"
      >{{ JSON.stringify(lastMessage, null, 2) }}</pre>
    </div>
  </div>
</template>
