import { ref, onBeforeUnmount } from 'vue'

// Manages the live WebSocket connection with exponential-backoff reconnects.
// The server (Milestone 1) gates the WS upgrade on the session cookie, so this
// is only started after authentication.
//
// Milestone 2 scope: connect, track status, expose the last message. Wiring
// messages into baseStore happens in Milestone 3.
export function useWebSocket(onMessage) {
  const status = ref('connecting') // connecting | open | closed
  const lastMessage = ref(null)

  let ws = null
  let attempt = 0
  let reconnectTimer = null
  let manualClose = false

  function url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/ws`
  }

  function scheduleReconnect() {
    if (manualClose) return
    attempt += 1
    const delay = Math.min(30000, 1000 * 2 ** (attempt - 1)) // 1s..30s cap
    reconnectTimer = setTimeout(connect, delay)
  }

  function connect() {
    status.value = 'connecting'
    ws = new WebSocket(url())

    ws.onopen = () => {
      attempt = 0
      status.value = 'open'
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        lastMessage.value = data
        if (onMessage) onMessage(data)
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      status.value = 'closed'
      scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose fires next and handles reconnect
      ws && ws.close()
    }
  }

  function close() {
    manualClose = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (ws) ws.close()
  }

  connect()
  onBeforeUnmount(close)

  return { status, lastMessage, close }
}
