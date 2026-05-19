import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/utils/api'

// Holds two things:
//  - live status streamed over the WebSocket (/update broadcasts)
//  - static farm definitions loaded once from /api/farms-config (farms.json)
// FarmGrid groups by wing; display metadata always comes from farmsConfig,
// never from the live payload (which is status-only).
export const useBaseStore = defineStore('base', () => {
  // Live state
  const power = ref(null) // { generation, consumption, ratio, state }
  const farmStatus = ref({}) // { [farmId]: { fill, running, override, online } }
  const alerts = ref([]) // [ { message, level, time } ]
  const receivedAt = ref(null) // server-stamped ms of the last payload

  // Static config
  const farmsConfig = ref(null)
  const configError = ref('')

  function applyMessage(msg) {
    if (!msg) return
    if (msg.power) power.value = msg.power
    if (msg.farms) farmStatus.value = msg.farms
    if (Array.isArray(msg.alerts)) alerts.value = msg.alerts
    receivedAt.value = msg.receivedAt || Date.now()
  }

  async function loadFarmsConfig() {
    try {
      farmsConfig.value = await api.get('/api/farms-config')
      configError.value = ''
    } catch (err) {
      configError.value = err.message || 'Failed to load farm config'
    }
  }

  const priorityLabels = computed(() => farmsConfig.value?.priority_labels || {})

  // Only wings that actually contain a farm, in farms.json order.
  const wings = computed(() => {
    const cfg = farmsConfig.value
    if (!cfg) return []
    return cfg.wings.filter((w) => cfg.farms.some((f) => f.wing === w.id))
  })

  // Farms in a wing, each merged with its live status, sorted by priority
  // tier then label. Returns config-shaped objects with a `.status` field.
  function farmsInWing(wingId) {
    const cfg = farmsConfig.value
    if (!cfg) return []
    return cfg.farms
      .filter((f) => f.wing === wingId)
      .map((f) => ({ ...f, status: farmStatus.value[f.id] || null }))
      .sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label))
  }

  const recentAlerts = computed(() => alerts.value.slice(0, 5))
  const hasData = computed(() => receivedAt.value !== null)

  return {
    power,
    farmStatus,
    alerts,
    receivedAt,
    farmsConfig,
    configError,
    priorityLabels,
    wings,
    recentAlerts,
    hasData,
    applyMessage,
    loadFarmsConfig,
    farmsInWing
  }
})
