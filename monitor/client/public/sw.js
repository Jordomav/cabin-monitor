// CABIN Base Monitor service worker — shows push notifications and handles
// taps on notification action buttons.

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'CABIN', body: event.data ? event.data.text() : '' }
  }

  const isCriticalPower = data.data?.type === 'power' && data.data?.state === 'critical'

  const options = {
    body: data.body,
    icon: data.icon || '/icon.png',
    badge: data.badge || '/badge.png',
    data: data.data || {},
    actions: data.actions || [],
    // Critical power alerts stay on screen until the user acts on them.
    requireInteraction: isCriticalPower,
    tag: data.data?.type, // collapse repeats of the same alert type
    renotify: true // ...but still alert (banner/sound) on each new one
  }

  event.waitUntil(self.registration.showNotification(data.title || 'CABIN', options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  // Action button: shut down low-priority farms without opening the app.
  if (event.action === 'shutdown_low') {
    event.waitUntil(
      fetch('/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ type: 'shutdown_priority', tier: 4 })
      })
    )
    return
  }

  // Any other tap (incl. "open_dashboard"): focus an existing tab or open one.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => 'focus' in c)
      if (existing) return existing.focus()
      return self.clients.openWindow('/')
    })
  )
})
