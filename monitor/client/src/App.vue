<script setup>
import { onMounted, watch, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAuthStore } from '@/stores/authStore'
import { useBaseStore } from '@/stores/baseStore'
import { useWebSocket } from '@/composables/useWebSocket'
import LoginPage from '@/components/LoginPage.vue'
import AppHeader from '@/components/Header.vue'
import PowerCard from '@/components/PowerCard.vue'
import FarmGrid from '@/components/FarmGrid.vue'
import AlertFeed from '@/components/AlertFeed.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import ManageFarms from '@/components/ManageFarms.vue'

const auth = useAuthStore()
const base = useBaseStore()
const { authenticated, checking } = storeToRefs(auth)

// WS is only started once authenticated (server gates the upgrade on the
// session cookie). Messages feed straight into baseStore.
const wsStatus = ref('connecting')
const showSettings = ref(false)
const showManage = ref(false)
let socket = null

function startSocket() {
  if (socket) return
  socket = useWebSocket((msg) => base.applyMessage(msg))
  watch(socket.status, (s) => (wsStatus.value = s), { immediate: true })
}

watch(
  authenticated,
  (isAuthed) => {
    if (isAuthed) {
      base.loadFarmsConfig()
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

  <div v-else class="min-h-screen pb-10" style="padding-bottom: calc(2.5rem + env(safe-area-inset-bottom))">
    <AppHeader
      :ws-status="wsStatus"
      @logout="auth.logout"
      @open-settings="showSettings = true"
      @open-manage="showManage = true"
    />
    <main class="max-w-md mx-auto px-3 pt-3 space-y-3">
      <PowerCard />
      <FarmGrid />
      <AlertFeed />
    </main>

    <SettingsPanel v-if="showSettings" @close="showSettings = false" />
    <ManageFarms v-if="showManage" @close="showManage = false" />
  </div>
</template>
