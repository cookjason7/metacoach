// ViewModeContext.jsx — read-only "view as client" mode for staff. Lets an
// admin/coach browse the app exactly as one of their clients would see it,
// without being able to change anything (server-side enforcement lives in
// resolveViewAs / blockWritesInViewMode, server/middleware/viewAsClient.js).
import { createContext, useContext, useState, useCallback } from 'react'

// Mutable, module-level mirror of the current view-mode state. The global
// fetch patch (see viewModeFetchPatch.js, installed once in main.jsx) reads
// this synchronously on every request — it runs outside React and can't use
// hooks or subscribe to context, so this plain object is the source of truth
// it consults to decide whether to attach X-View-As-Client-Id.
export const viewModeState = { viewing: false, clientId: null }

const ViewModeContext = createContext({
  viewing: false,
  viewedClient: null,
  enterViewMode: () => {},
  exitViewMode: () => {},
})

export function ViewModeProvider({ children }) {
  const [viewing, setViewing] = useState(false)
  const [viewedClient, setViewedClient] = useState(null)

  // `client` carries whatever the caller already has loaded (see ClientProfile.jsx)
  // — at minimum { id, name }, optionally coaching_type/goal_* so pages that read
  // profile data from /api/users/me (which is never view-as-aware — see Build A's
  // Settings.jsx audit) have a same-session snapshot to fall back on instead of
  // showing the staff member's own empty profile.
  const enterViewMode = useCallback((client) => {
    if (!client?.id) return
    viewModeState.viewing  = true
    viewModeState.clientId = client.id
    setViewedClient(client)
    setViewing(true)
  }, [])

  const exitViewMode = useCallback(() => {
    viewModeState.viewing  = false
    viewModeState.clientId = null
    setViewing(false)
    setViewedClient(null)
  }, [])

  return (
    <ViewModeContext.Provider value={{ viewing, viewedClient, enterViewMode, exitViewMode }}>
      {children}
    </ViewModeContext.Provider>
  )
}

export function useViewMode() {
  return useContext(ViewModeContext)
}
