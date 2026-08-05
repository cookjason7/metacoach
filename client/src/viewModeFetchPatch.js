// One-time global fetch patch: while view-as-client mode is active, attach
// X-View-As-Client-Id to every request this app makes to its own API so the
// server resolves the effective identity to the viewed client (see
// server/middleware/viewAsClient.js). Installed once from main.jsx, before
// the app renders, so no call site has to know about view mode at all.
import { viewModeState } from './context/ViewModeContext.jsx'

const VIEW_AS_HEADER = 'X-View-As-Client-Id'

// Matches this app's own /api/* calls regardless of whether API_URL is a
// relative empty string (same-origin Railway deploy) or an absolute host
// (split-service/local dev) — see client/src/config.js. Anything else
// (Capacitor camera webPath/blob URLs, third-party links) is left untouched.
function isOwnApiRequest(url) {
  try {
    const resolved = new URL(url, window.location.origin)
    return resolved.pathname.startsWith('/api/')
  } catch {
    return false
  }
}

let installed = false

export function installViewModeFetchPatch() {
  if (installed) return
  installed = true

  const originalFetch = window.fetch.bind(window)

  window.fetch = (input, init) => {
    if (!viewModeState.viewing || !viewModeState.clientId) return originalFetch(input, init)

    const url = typeof input === 'string' || input instanceof URL ? String(input) : (input?.url ?? '')
    if (!isOwnApiRequest(url)) return originalFetch(input, init)

    const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input?.headers : undefined) ?? {})
    headers.set(VIEW_AS_HEADER, String(viewModeState.clientId))
    return originalFetch(input, { ...init, headers })
  }
}
