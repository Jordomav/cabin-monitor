import { ref, onMounted } from 'vue'
import { api } from '@/utils/api'

// Per-device notification setup. Permission + subscription live in the browser;
// per-type prefs persist in localStorage and are mirrored to the server so it
// can filter before sending.

const ALERT_TYPES = ['power', 'farm_offline', 'vault_full']
const PREFS_KEY = 'cabin-push-prefs'

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    return Object.fromEntries(ALERT_TYPES.map((t) => [t, saved[t] !== false]))
  } catch {
    return Object.fromEntries(ALERT_TYPES.map((t) => [t, true]))
  }
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export function usePushNotifications() {
  const supported = ref(
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  )
  const permission = ref(supported.value ? Notification.permission : 'unsupported')
  const subscribed = ref(false)
  const busy = ref(false)
  const error = ref('')
  const prefs = ref(loadPrefs())

  async function refreshState() {
    if (!supported.value) return
    permission.value = Notification.permission
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    subscribed.value = !!sub
  }

  async function pushSubscriptionToServer(sub) {
    await api.post('/push/subscribe', { subscription: sub, prefs: prefs.value })
  }

  async function enable() {
    if (!supported.value || busy.value) return
    busy.value = true
    error.value = ''
    try {
      const perm = await Notification.requestPermission()
      permission.value = perm
      if (perm !== 'granted') {
        error.value = 'Notification permission denied'
        return
      }
      const { key, enabled } = await api.get('/push/public-key')
      if (!enabled || !key) {
        error.value = 'Push not configured on the server'
        return
      }
      const reg = await navigator.serviceWorker.ready
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key)
        }))
      await pushSubscriptionToServer(sub)
      subscribed.value = true
    } catch (err) {
      error.value = err.message || 'Failed to enable notifications'
    } finally {
      busy.value = false
    }
  }

  async function disable() {
    if (!supported.value || busy.value) return
    busy.value = true
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await api.del('/push/subscribe', { endpoint: sub.endpoint }).catch(() => {})
        await sub.unsubscribe()
      }
      subscribed.value = false
    } catch (err) {
      error.value = err.message || 'Failed to disable'
    } finally {
      busy.value = false
    }
  }

  async function setPref(type, value) {
    prefs.value = { ...prefs.value, [type]: value }
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value))
    if (subscribed.value) {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) await pushSubscriptionToServer(sub)
    }
  }

  onMounted(refreshState)

  return {
    supported,
    permission,
    subscribed,
    busy,
    error,
    prefs,
    alertTypes: ALERT_TYPES,
    enable,
    disable,
    setPref
  }
}
