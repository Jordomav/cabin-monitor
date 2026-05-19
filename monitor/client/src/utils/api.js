// Thin fetch wrapper. All requests are same-origin (Vite proxies to the Node
// server in dev; the server serves the built app in prod), so relative paths
// plus credentials: 'include' carry the session cookie everywhere.

async function request(method, path, body) {
  const opts = {
    method,
    credentials: 'include',
    headers: {}
  }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }

  const res = await fetch(path, opts)
  let data = null
  try {
    data = await res.json()
  } catch {
    // non-JSON response (e.g. HTML fallback) — leave data null
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  del: (path, body) => request('DELETE', path, body)
}
