import { useState, useEffect, useCallback, useRef } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { UserButton, useUser, useAuth, useClerk } from '@clerk/clerk-react'
import { API_URL } from '../config.js'
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { syncAppleHealthToday } from '../hooks/useAppleHealth.js'

// Client-facing sidebar nav
const CLIENT_NAV_ITEMS = [
  { to: '/dashboard',    label: 'Dashboard' },
  { to: '/ai-coach',     label: 'Coach Katie' },
  { to: '/journal',      label: 'Food Log' },
  { to: '/progress',     label: 'Progress' },
  { to: '/calendar',     label: 'Calendar' },
  { to: '/messages',     label: 'Messages' },
  { to: '/food-list',    label: 'Food List' },
  { to: '/community',    label: 'Community' },
  { to: '/community?tab=mindset', label: 'Brain Mapping', matchPath: '/community', matchSearch: 'tab=mindset' },
  { to: '/settings',     label: 'Settings' },
]

// Coach / admin sidebar nav — no personal food/fitness items
const STAFF_NAV_ITEMS = [
  { to: '/dashboard',     label: 'Coaching Dashboard' },
  { to: '/admin/forms',   label: 'Forms' },
  { to: '/messages',      label: 'Messages' },
  { to: '/community',     label: 'Community' },
  { to: '/settings',      label: 'Settings' },
]

const SIDEBAR_BG = '#0F1E35'

export default function Layout() {
  const { user, isLoaded } = useUser()
  const { getToken }       = useAuth()
  const { signOut }        = useClerk()
  const navigate           = useNavigate()
  const location           = useLocation()
  const [isAdmin,      setIsAdmin]      = useState(false)
  const [isStaff,      setIsStaff]      = useState(false)
  const [coachingType, setCoachingType] = useState(null) // 'vip' | 'ai' | 'hybrid' | 'basic' — null until loaded
  const [bloodworkEnabled, setBloodworkEnabled] = useState(false) // per-client flag from /api/users/me
  const [notifCount,   setNotifCount]   = useState(0)
  const [katieUnread,  setKatieUnread]  = useState(0)
  const [msgUnread,    setMsgUnread]    = useState(0)
  const [sidebarOpen,  setSidebarOpen]  = useState(false)
  const [quickMenuOpen,       setQuickMenuOpen]       = useState(false)
  const [quickAction,         setQuickAction]         = useState(null)
  const [quickValue,          setQuickValue]          = useState('')
  const [quickWaterMode,      setQuickWaterMode]      = useState('add')
  const [quickSaving,         setQuickSaving]         = useState(false)
  const [quickDone,           setQuickDone]           = useState(false)
  const [quickActivityType,   setQuickActivityType]   = useState('')
  const [quickActivityDur,    setQuickActivityDur]    = useState('')
  const [quickActivityNotes,  setQuickActivityNotes]  = useState('')
  const [quickPhotoAngle,     setQuickPhotoAngle]     = useState('front')
  const [quickPhotoFile,      setQuickPhotoFile]      = useState(null)
  const [quickPhotoPreview,   setQuickPhotoPreview]   = useState(null)
  const quickPhotoInputRef    = useRef(null)
  const quickPhotoGalleryRef  = useRef(null)
  const overlayPressedRef     = useRef(false) // true only when a pointer press began on the backdrop itself (ghost-click guard)
  const [quickFoodMode, setQuickFoodMode] = useState(null) // 'search'|'barcode'|'photo'|'manual'
  const [quickError,    setQuickError]    = useState(null) // visible error message for failed saves
  // Date chosen in the meal-slot picker (food); defaults to today each time the menu opens
  const [quickLogDate, setQuickLogDate] = useState(() => new Date().toISOString().slice(0, 10))
  // Date chosen in quick-log forms (weight/water/steps/sleep/activity/photo)
  const [quickActionDate, setQuickActionDate] = useState(() => new Date().toISOString().slice(0, 10))

  function resetQuickExtras() {
    setQuickActivityType(''); setQuickActivityDur(''); setQuickActivityNotes('')
    setQuickPhotoAngle('front'); setQuickPhotoFile(null)
    setQuickPhotoPreview(p => { if (p) URL.revokeObjectURL(p); return null })
    setQuickFoodMode(null)
    setQuickLogDate(new Date().toISOString().slice(0, 10))
    setQuickActionDate(new Date().toISOString().slice(0, 10))
  }

  function openQuickMenu() {
    overlayPressedRef.current = false
    setQuickMenuOpen(true)
    setQuickAction(null)
    setQuickValue('')
    setQuickWaterMode('add')
    setQuickDone(false)
    setQuickError(null)
    resetQuickExtras()
  }

  // Backdrop tap-to-close. We only close when a pointer press actually STARTED
  // on the backdrop. The tap that opens the sheet presses on the plus button
  // (the backdrop doesn't exist yet), so its trailing synthetic/"ghost" click —
  // which lands on the freshly-mounted backdrop — has no matching pointerdown
  // here and is ignored. This removes the open/close flicker without relying on
  // a fragile timing guard.
  function handleOverlayPointerDown(e) {
    overlayPressedRef.current = e.target === e.currentTarget
  }
  function handleOverlayClick(e) {
    const shouldClose = overlayPressedRef.current && e.target === e.currentTarget
    overlayPressedRef.current = false
    if (shouldClose) closeQuickMenu()
  }

  function closeQuickMenu() {
    setQuickMenuOpen(false)
    setQuickAction(null)
    setQuickValue('')
    setQuickWaterMode('add')
    setQuickDone(false)
    setQuickError(null)
    resetQuickExtras()
  }

  async function submitQuickLog(waterMode = quickWaterMode) {
    if (!quickValue || quickSaving) return
    setQuickSaving(true)
    setQuickError(null)
    try {
      const token = await getToken()
      const todayStr = new Date().toISOString().slice(0, 10)
      const isToday  = quickActionDate === todayStr
      let body = { log_date: quickActionDate }

      if (quickAction === 'water') {
        if (isToday) {
          // Add/subtract from existing today's total
          const todayRes = await fetch(`${API_URL}/api/daily-logs/today`, { headers: { Authorization: `Bearer ${token}` } })
          const todayData = todayRes.ok ? await todayRes.json() : {}
          const currentWater = parseFloat(todayData.water_oz) || 0
          const delta = Math.abs(parseFloat(quickValue) || 0)
          body.water_oz = Math.max(0, waterMode === 'subtract' ? currentWater - delta : currentWater + delta)
        } else {
          // Past date — set total directly
          body.water_oz = Math.max(0, Math.abs(parseFloat(quickValue) || 0))
        }
      } else if (quickAction === 'weight') {
        body.weight_lbs = Number(quickValue)
      } else if (quickAction === 'steps') {
        body.steps = Number(quickValue)
      } else if (quickAction === 'sleep') {
        body.sleep_minutes = Math.round(Number(quickValue) * 60)
      }
      const res = await fetch(`${API_URL}/api/daily-logs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Failed to save. Please try again.')
      const saved = await res.json().catch(() => null)
      // Only fire the dashboard-refresh event when logging for today
      if (saved && isToday) window.dispatchEvent(new CustomEvent('daily-log-updated', { detail: saved }))
      setQuickDone(true)
      setTimeout(() => closeQuickMenu(), 1200)
    } catch (err) {
      setQuickError(err?.message ?? 'Save failed. Please try again.')
    }
    finally { setQuickSaving(false) }
  }

  // Clears steps or sleep so auto-sync can fill them again
  async function clearQuickLog() {
    if (quickSaving) return
    setQuickSaving(true)
    setQuickError(null)
    try {
      const token = await getToken()
      const body = quickAction === 'steps'
        ? { steps: null }
        : quickAction === 'sleep'
          ? { sleep_minutes: null }
          : null
      if (!body) return
      const res = await fetch(`${API_URL}/api/daily-logs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Failed to clear. Please try again.')
      setQuickDone(true)
      setTimeout(() => closeQuickMenu(), 1200)
    } catch (err) {
      setQuickError(err?.message ?? 'Save failed. Please try again.')
    }
    finally { setQuickSaving(false) }
  }

  async function submitQuickActivity() {
    if (!quickActivityType || quickSaving) return
    setQuickSaving(true)
    setQuickError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/workouts/log-activity`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_type:    quickActivityType,
          duration_minutes: quickActivityDur ? Number(quickActivityDur) : null,
          notes:            quickActivityNotes || null,
          log_date:         quickActionDate,
        }),
      })
      if (!res.ok) throw new Error('Failed to save activity. Please try again.')
      setQuickDone(true)
      setTimeout(() => closeQuickMenu(), 1200)
    } catch (err) {
      setQuickError(err?.message ?? 'Save failed. Please try again.')
    }
    finally { setQuickSaving(false) }
  }

  async function submitQuickPhoto() {
    if (!quickPhotoFile || quickSaving) return
    setQuickSaving(true)
    setQuickError(null)
    try {
      const token = await getToken()
      const body = new FormData()
      body.append('photo', quickPhotoFile)
      body.append('angle', quickPhotoAngle)
      body.append('taken_at_date', quickActionDate)
      const res = await fetch(`${API_URL}/api/progress-photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      })
      if (!res.ok) throw new Error('Upload failed. Please try again.')
      if (quickPhotoPreview) URL.revokeObjectURL(quickPhotoPreview)
      setQuickPhotoFile(null)
      setQuickPhotoPreview(null)
      if (quickPhotoInputRef.current) quickPhotoInputRef.current.value = ''
      setQuickDone(true)
      setTimeout(() => closeQuickMenu(), 1200) // was setQuickDone(false) — sheet now closes on success
    } catch (err) {
      setQuickError(err?.message ?? 'Upload failed. Please try again.')
    }
    finally { setQuickSaving(false) }
  }

  const fetchRole = useCallback(async () => {
    if (!isLoaded || !user) return
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) {
        console.warn('[layout] /api/users/me returned', res.status)
        return
      }
      const data = await res.json()
      const adminStatus = data.role === 'admin' || data.role === 'account_owner'
      const staffStatus = adminStatus || data.role === 'coach' || data.role === 'staff'
      setIsAdmin(adminStatus)
      setIsStaff(staffStatus)
      setCoachingType(data.coaching_type ?? 'vip')
      setBloodworkEnabled(data.bloodwork_enabled === true)
    } catch (err) {
      console.error('[layout] fetchRole error:', err)
    }
  }, [getToken, isLoaded, user])

  const fetchNotifCount = useCallback(async () => {
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/community/notifications/count`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json()
      setNotifCount(data.count ?? 0)
    } catch {}
  }, [getToken])

  const fetchMsgUnread = useCallback(async () => {
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/messages/unread-count`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json()
      setMsgUnread(data.unread ?? 0)
    } catch {}
  }, [getToken])

  const fetchKatieUnread = useCallback(async () => {
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/coach/unread-count`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json()
      setKatieUnread(data.count ?? 0)
    } catch {}
  }, [getToken])

  useEffect(() => {
    fetchRole()
  }, [fetchRole])

  // ── Unauthenticated app-load diagnostic — fires once on mount, no auth needed ──
  useEffect(() => {
    try {
      const payload = {
        build:    'app-load-debug-b1',
        platform: Capacitor.getPlatform(),
        isNative: Capacitor.isNativePlatform(),
        href:     window.location.href,
        userAgent: navigator.userAgent,
      }
      fetch(`${API_URL}/api/push/app-load-debug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {})
    } catch {}
  }, [])

  // ── Android push notification registration ────────────────────────────────
  // Runs once the user is authenticated. Non-blocking — all errors are warnings.
  const pushTokenRef = useRef(null)
  useEffect(() => {
    if (!isLoaded || !user) return
    const isNative = Capacitor.isNativePlatform()
    const platform = Capacitor.getPlatform()
    console.log('[push] native platform check', { isNative, platform })

    // Fire-and-forget diagnostic ping — never includes the FCM token value
    const sendDebug = async (step, value) => {
      try {
        const clerkToken = await getToken()
        const body = { step }
        if (value !== undefined) body.value = String(value)
        await fetch(`${API_URL}/api/push/debug`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${clerkToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch {}
    }

    // Always fires — visible in production logs even when isNative=false
    sendDebug('native-detected', `isNative=${isNative} platform=${platform}`)

    if (!isNative) return

    let cancelled = false
    let regListener = null
    let errListener = null

    const getCachedPushToken = () => {
      try {
        return window.localStorage.getItem('metacoach_push_token')
      } catch {
        return null
      }
    }

    const cachePushToken = (token) => {
      try {
        window.localStorage.setItem('metacoach_push_token', token)
      } catch {}
    }

    const postPushToken = async (token, source) => {
      if (!token || typeof token !== 'string') return false

      pushTokenRef.current = token
      cachePushToken(token)

      const tokenStart = token.slice(0, 12)
      sendDebug('post-start', `source=${source} len=${token.length}`)
      try {
        const clerkToken = await getToken()
        const res = await fetch(`${API_URL}/api/push/register`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${clerkToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, platform }),
        })
        const text = await res.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {}

        if (!res.ok) {
          console.warn('[push] token POST failed', {
            status: res.status,
            platform,
            source,
            tokenStart,
            response: text?.slice(0, 160),
          })
          sendDebug('post-failed', `status=${res.status} source=${source}`)
          return false
        }

        console.log('[push] FCM token registered', {
          status: res.status,
          platform,
          source,
          tokenStart,
          deviceId: data?.deviceId,
        })
        sendDebug('post-success', `deviceId=${data?.deviceId} source=${source}`)
        return true
      } catch (err) {
        const msg = String(err?.message ?? err ?? 'unknown')
        console.warn('[push] token POST failed', {
          platform,
          source,
          tokenStart,
          error: msg,
        })
        sendDebug('post-error', `source=${source} err=${msg.slice(0, 80)}`)
        return false
      }
    }

    ;(async () => {
      try {
        // Register listeners BEFORE calling register() so the token event is not missed
        regListener = await PushNotifications.addListener('registration', async ({ value: token }) => {
          if (cancelled) return
          const tokenLength = token?.length ?? 0
          console.log('[push] registration token received', {
            platform,
            tokenStart: token?.slice(0, 12),
            tokenLength,
          })
          sendDebug('token-received', `len=${tokenLength}`)
          await postPushToken(token, 'registration-event')
        })

        errListener = await PushNotifications.addListener('registrationError', (err) => {
          const msg = String(err?.error ?? err ?? 'unknown')
          console.warn('[push] FCM registration error:', msg)
          sendDebug('registration-error', msg.slice(0, 128))
        })

        sendDebug('listeners-added')

        const { receive } = await PushNotifications.requestPermissions()
        console.log('[push] permission result', { receive, platform })
        sendDebug('permission', receive)
        if (receive !== 'granted') {
          console.log('[push] permission not granted — skipping registration')
          return
        }

        const cachedToken = getCachedPushToken()
        if (cachedToken) {
          sendDebug('cached-token-found', `len=${cachedToken.length}`)
          await postPushToken(cachedToken, 'cached-token')
        } else {
          sendDebug('no-cached-token')
        }

        console.log('[push] requesting native registration', { platform })
        sendDebug('register-called')
        await PushNotifications.register()
        sendDebug('register-returned')
      } catch (err) {
        const msg = String(err?.message ?? err ?? 'unknown')
        console.warn('[push] push setup error:', msg)
        sendDebug('setup-error', msg.slice(0, 128))
      }
    })()

    return () => {
      cancelled = true
      regListener?.remove()
      errListener?.remove()
    }
  }, [isLoaded, user, getToken])

  // ── Apple Health auto-sync on foreground ──────────────────────────────────
  // Fires silently when the iOS app returns from background (visibilitychange
  // fires in Capacitor WebViews just like a browser tab becoming visible).
  // A 5-minute cooldown prevents hammering the server if the user multi-tasks.
  // No UI shown — the 'daily-log-updated' event from syncAppleHealthToday()
  // updates the Dashboard in real-time when it fires.
  useEffect(() => {
    if (!isLoaded || !user) return
    if (Capacitor.getPlatform() !== 'ios') return

    const COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

    async function doAutoSync() {
      const last = localStorage.getItem('ah_last_synced')
      if (last && Date.now() - new Date(last).getTime() < COOLDOWN_MS) return
      try {
        const token = await getToken()
        const data  = await syncAppleHealthToday(token)
        if (!data.error) {
          // Update the last-synced timestamp that Settings reads for display
          try { localStorage.setItem('ah_last_synced', new Date().toISOString()) } catch {}
        }
      } catch {
        // Silent — auto-sync failures must never surface an error to the user
      }
    }

    // Sync when app comes to foreground
    function onVisibilityChange() {
      if (!document.hidden) doAutoSync()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    // Also sync once on authenticated mount (covers cold-launch from TestFlight)
    doAutoSync()

    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [isLoaded, user, getToken])

  useEffect(() => {
    fetchNotifCount()
    const id = setInterval(fetchNotifCount, 60_000)
    return () => clearInterval(id)
  }, [fetchNotifCount])

  useEffect(() => {
    fetchKatieUnread()
    const id = setInterval(fetchKatieUnread, 60_000)
    return () => clearInterval(id)
  }, [fetchKatieUnread])

  useEffect(() => {
    fetchMsgUnread()
    const id = setInterval(fetchMsgUnread, 60_000)
    return () => clearInterval(id)
  }, [fetchMsgUnread])

  // Non-VIP clients (ai, hybrid, basic) use the Support/ai_admin messaging path.
  const isNonVipClient = !isStaff && coachingType !== null && coachingType !== 'vip'
  // Basic clients have no Community or Brain Mapping access.
  const isBasicClient = !isStaff && coachingType === 'basic'

  // Non-VIP clients do not have Calendar in the sidebar; Basic also loses community.
  const baseClientNav = CLIENT_NAV_ITEMS.filter(item => {
    if (isNonVipClient && item.label === 'Calendar') return false
    if (isBasicClient && (item.label === 'Community' || item.label === 'Brain Mapping')) return false
    return true
  })

  // Non-VIP clients (ai, hybrid, basic) see "Support" instead of "Messages".
  const clientNavWithLabels = isNonVipClient
    ? baseClientNav.map(item => item.label === 'Messages' ? { ...item, label: 'Support' } : item)
    : baseClientNav

  // Super-admin gets an extra "Usage Analytics" nav entry.
  const navItems = isStaff
    ? isAdmin
      ? [...STAFF_NAV_ITEMS, { to: '/admin/usage', label: 'Usage Analytics' }]
      : STAFF_NAV_ITEMS
    : clientNavWithLabels

  // Mobile drawer hides items already in the client bottom nav.
  const mobileBottomNavLabels = isBasicClient
    ? new Set(['Dashboard', 'Coach Katie', 'Food Log', 'Support'])
    : isNonVipClient
      ? new Set(['Dashboard', 'Coach Katie', 'Food Log', 'Community'])
      : new Set(['Dashboard', 'Food Log', 'Messages', 'Community', 'Calendar'])
  const mobileNavItems = isStaff ? navItems : navItems.filter(i => !mobileBottomNavLabels.has(i.label))

  function buildSidebarContent(items, isMobile = false) { return (
    <>
      {/* Logo */}
      <div className="flex justify-center mt-6 mb-5 px-3">
        <img
          src="/brand/warriorfit-logo-full-sidebar.png"
          alt="WarriorFIT AI"
          className={isMobile ? "w-[59px] h-auto block" : "w-[102px] h-auto block"}
        />
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 space-y-0.5">
        {items.map(({ to, href, label, matchPath, matchSearch }) =>
          href ? (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setSidebarOpen(false)}
              className="flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-white/70 hover:bg-white/10 hover:text-white"
            >
              {label}
            </a>
          ) : (
            <NavLink
              key={to}
              to={to}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) => {
                // For items with matchSearch (e.g. Brain Mapping), active only when search param matches
                const active = matchSearch
                  ? location.pathname === matchPath && location.search.includes(matchSearch)
                  : isActive && !(matchPath === undefined && label === 'Community' && location.search.includes('tab=mindset'))
                return `flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-[#E8670A] text-white'
                    : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`
              }}
            >
              {label}
              {label === 'Community' && notifCount > 0 && (
                <span className="ml-auto w-2 h-2 bg-red-500 rounded-full" />
              )}
              {label === 'Coach Katie' && katieUnread > 0 && (
                <span className="ml-auto flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-[#E8670A] text-white text-[10px] font-bold px-1">
                  {katieUnread}
                </span>
              )}
              {(label === 'Messages' || label === 'Support') && msgUnread > 0 && (
                <span className="ml-auto flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-[#E8670A] text-white text-[10px] font-bold px-1">
                  {msgUnread}
                </span>
              )}
            </NavLink>
          )
        )}
      </nav>

      {/* User */}
      <div className="px-4 pt-3 pb-2 flex items-center gap-3" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
        <UserButton afterSignOutUrl="/sign-in" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">
            {user?.fullName ?? user?.username ?? 'Account'}
          </p>
          <p className="text-xs truncate" style={{ color: 'rgba(255,255,255,0.45)' }}>
            {user?.primaryEmailAddress?.emailAddress}
          </p>
        </div>
      </div>

      {/* Logout — always visible, pinned to bottom */}
      <div className="px-4 pb-20 lg:pb-4">
        <button
          onClick={async () => {
            // Unregister push token on logout so stale tokens are cleaned up promptly
            if (Capacitor.isNativePlatform() && pushTokenRef.current) {
              try {
                const clerkToken = await getToken()
                await fetch(`${API_URL}/api/push/unregister`, {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${clerkToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ token: pushTokenRef.current }),
                })
              } catch {}
            }
            signOut(() => navigate('/sign-in'))
          }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold transition-colors bg-red-600/20 text-red-400 hover:bg-red-600 hover:text-white"
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h6a2 2 0 012 2v1" />
          </svg>
          Log Out
        </button>
      </div>
    </>
  ) }

  return (
    <div className="flex h-screen bg-gray-50">

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-60 flex-shrink-0 flex-col" style={{ backgroundColor: SIDEBAR_BG }}>
        {buildSidebarContent(navItems)}
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="relative z-50 w-60 flex flex-col flex-shrink-0" style={{ backgroundColor: SIDEBAR_BG }}>
            {buildSidebarContent(mobileNavItems, true)}
          </aside>
        </div>
      )}

      <main className="flex-1 overflow-y-auto p-4 lg:p-8 pb-[calc(7.5rem+env(safe-area-inset-bottom))] lg:pb-8">
        {/* Mobile hamburger */}
        <button
          className="lg:hidden mb-4 p-2 min-w-[44px] min-h-[44px] rounded-lg text-gray-500 hover:bg-gray-200 transition-colors"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open menu"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <Outlet />
      </main>

      {/* Mobile bottom nav
            Staff:       Coaching | Clients | Messages | Community
            Basic:       Home | Food Log | Katie | Support
            AI/Hybrid:   Home | Food Log | Katie | Community
            VIP:         Home | Calendar | Food Log | Messages | Community  */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200 flex pb-[env(safe-area-inset-bottom)]">
        {(isStaff ? [
          // Staff bottom nav (unchanged)
          { to: '/dashboard',     label: 'Coaching',  badge: false,             icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" /> },
          { to: '/admin/clients', label: 'Clients',   badge: false,             icon: <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
          { to: '/messages',      label: 'Messages',  badge: msgUnread > 0,     icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /> },
          { to: '/community',     label: 'Community', badge: notifCount > 0,    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
        ] : isBasicClient ? [
          // Basic client bottom nav: Home | Food Log | Katie | Support  (no Community)
          { to: '/dashboard', label: 'Home',     badge: false,             icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /> },
          { to: '/journal',   label: 'Food Log', badge: false,             icon: <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /> },
          { to: '/ai-coach',  label: 'Katie',    badge: katieUnread > 0,   icon: <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /> },
          { to: '/messages',  label: 'Support',  badge: msgUnread > 0,     icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /> },
        ] : isNonVipClient ? [
          // AI / Hybrid client bottom nav: Home | Food Log | Katie | Community
          { to: '/dashboard', label: 'Home',      badge: false,            icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /> },
          { to: '/journal',   label: 'Food Log',  badge: false,            icon: <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /> },
          { to: '/ai-coach',  label: 'Katie',     badge: katieUnread > 0,  icon: <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /> },
          { to: '/community', label: 'Community', badge: notifCount > 0,   icon: <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
        ] : [
          // VIP client bottom nav: Home | Calendar | Food Log | Messages | Community  (unchanged)
          { to: '/dashboard', label: 'Home',      badge: false,          icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /> },
          { to: '/calendar',  label: 'Calendar',  badge: false,          icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /> },
          { to: '/journal',   label: 'Food Log',  badge: false,          icon: <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /> },
          { to: '/messages',  label: 'Messages',  badge: msgUnread > 0,  icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /> },
          { to: '/community', label: 'Community', badge: notifCount > 0, icon: <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
        ]).map(({ to, label, icon, badge }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-[11px] font-medium transition-colors min-w-0 ${
                isActive ? 'text-[#E8670A]' : 'text-gray-400'
              }`
            }
          >
            <div className="relative">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                {icon}
              </svg>
              {badge && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-[#E8670A] rounded-full" />
              )}
            </div>
            <span className="max-w-full truncate">{label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Floating quick-log button — client only, above bottom nav on the right */}
      {!isStaff && !quickMenuOpen && (
        <button
          className="lg:hidden fixed right-4 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-1 active:scale-95 transition-transform"
          onClick={openQuickMenu}
          aria-label="Quick log"
        >
          <div className="w-14 h-14 rounded-full bg-[#E8670A] shadow-lg flex items-center justify-center">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <span className="text-[11px] font-semibold text-[#E8670A] leading-none drop-shadow-sm">Log</span>
        </button>
      )}
      {/* Quick-log bottom sheet */}
      {quickMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-[70] bg-black/40"
            onPointerDown={handleOverlayPointerDown}
            onClick={handleOverlayClick}
          />
          <div className="fixed bottom-0 left-0 right-0 z-[70] bg-white rounded-t-2xl shadow-2xl max-h-[calc(100dvh-1rem)] overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            {/* drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            {/* header */}
            <div className="flex items-center justify-between px-5 py-3">
              {(quickAction || quickFoodMode) ? (
                <button
                  onClick={() => {
                    if (quickAction) { setQuickAction(null); setQuickValue(''); setQuickDone(false); setQuickError(null); resetQuickExtras() }
                    else setQuickFoodMode(null)
                  }}
                  className="flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-gray-800"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                  Back
                </button>
              ) : (
                <h2 className="text-base font-bold text-gray-900">Quick Log</h2>
              )}
              <button onClick={closeQuickMenu} className="w-11 h-11 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 text-lg leading-none">
                ×
              </button>
            </div>

            {/* Error feedback — shown when a save fails */}
            {quickError && !quickDone && (
              <div className="mx-5 mb-1 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 font-medium">
                {quickError}
              </div>
            )}

            {/* ── Main tile grid (food + quick logs) ───────────────────── */}
            {!quickAction && !quickFoodMode && (
              <div className="px-4 pb-10 pt-1 space-y-4">
                {/* Food section */}
                <div>
                  <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2 px-0.5">Food</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { id: 'text',    emoji: '💬', label: 'Text Entry'   },
                      { id: 'search',  emoji: '🔍', label: 'Search Food'  },
                      { id: 'barcode', emoji: '🏷️', label: 'Scan Barcode' },
                      { id: 'photo',   emoji: '📷', label: 'Food Photo'   },
                    ].map(({ id, emoji, label }) => (
                      <button
                        key={id}
                        onClick={() => setQuickFoodMode(id)}
                        className="flex flex-col items-center justify-center gap-2 bg-orange-50 hover:bg-[#fcd9b0] active:bg-[#fbc090] border border-orange-100 rounded-2xl py-4 px-2 transition-colors min-h-[84px]"
                      >
                        <span className="text-2xl leading-none">{emoji}</span>
                        <span className="text-xs font-semibold text-gray-700 text-center leading-tight">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Quick Logs section */}
                <div>
                  <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2 px-0.5">Quick Logs</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {[
                      { id: 'weight',   emoji: '⚖️', label: 'Log Weight'     },
                      { id: 'water',    emoji: '💧', label: 'Log Water'      },
                      { id: 'steps',    emoji: '👟', label: 'Log Steps'      },
                      { id: 'photo',    emoji: '📸', label: 'Progress Photo' },
                      { id: 'sleep',    emoji: '😴', label: 'Sleep'          },
                      { id: 'activity', emoji: '🏃', label: 'Activity'       },
                      ...(bloodworkEnabled ? [{ id: 'bloodwork', emoji: '🩸', label: 'Upload Bloodwork' }] : []),
                    ].map(({ id, emoji, label }) => (
                      <button
                        key={id}
                        onClick={() => {
                          if (id === 'bloodwork') {
                            closeQuickMenu()
                            navigate('/settings?section=bloodwork')
                          } else {
                            setQuickAction(id)
                          }
                        }}
                        className="flex flex-col items-center justify-center gap-2 bg-gray-50 hover:bg-[#fde8c8] active:bg-[#fcd9b0] rounded-2xl py-4 px-2 transition-colors min-h-[84px]"
                      >
                        <span className="text-2xl leading-none">{emoji}</span>
                        <span className="text-xs font-semibold text-gray-700 text-center leading-tight">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── Meal picker (shown after tapping a food action) ───────── */}
            {quickFoodMode && !quickAction && !quickDone && (
              <div className="px-4 pb-10 pt-2 space-y-4">
                {/* Date selector — lets users log to a past date */}
                <div>
                  <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2">
                    Log date
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={quickLogDate}
                      max={new Date().toISOString().slice(0, 10)}
                      min={new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}
                      onChange={e => setQuickLogDate(e.target.value || new Date().toISOString().slice(0, 10))}
                      className="flex-1 border border-gray-300 rounded-xl px-3 py-2.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
                    />
                    {quickLogDate !== new Date().toISOString().slice(0, 10) && (
                      <button
                        onClick={() => setQuickLogDate(new Date().toISOString().slice(0, 10))}
                        className="shrink-0 text-xs font-semibold text-[#E8670A] hover:text-[#c45e09] transition-colors px-2"
                      >
                        Today
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2">Which meal?</p>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { slot: 'Breakfast', emoji: '🌅', label: 'Breakfast' },
                      { slot: 'Lunch',     emoji: '☀️', label: 'Lunch'     },
                      { slot: 'Dinner',    emoji: '🌙', label: 'Dinner'    },
                      { slot: 'Snack',     emoji: '🍎', label: 'Snack'     },
                    ].map(({ slot, emoji, label }) => (
                      <button
                        key={slot}
                        onClick={() => {
                          closeQuickMenu()
                          navigate('/journal', { state: { openSlot: slot, openMode: quickFoodMode, logDate: quickLogDate } })
                        }}
                        className="flex items-center gap-3 bg-gray-50 hover:bg-orange-50 hover:border-[#E8670A] border border-gray-200 rounded-2xl px-4 py-4 transition-all min-h-[60px]"
                      >
                        <span className="text-2xl">{emoji}</span>
                        <span className="text-sm font-semibold text-gray-700">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* success state */}
            {quickAction && quickDone && (
              <div className="px-5 pb-12 pt-4 text-center">
                <p className="text-3xl mb-2">✅</p>
                <p className="text-sm font-semibold text-gray-700">Saved!</p>
              </div>
            )}

            {/* mini-form */}
            {quickAction && !quickDone && (
              <div className="px-5 pb-10 pt-2">
                {/* ── Shared date picker — shown for all quick-log actions ── */}
                {(() => {
                  const todayStr = new Date().toISOString().slice(0, 10)
                  const minStr   = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
                  return (
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-xs font-medium text-gray-500 shrink-0">Date</span>
                      <input
                        type="date"
                        value={quickActionDate}
                        min={minStr}
                        max={todayStr}
                        onChange={e => setQuickActionDate(e.target.value || todayStr)}
                        className="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
                      />
                      {quickActionDate !== todayStr && (
                        <button
                          onClick={() => setQuickActionDate(todayStr)}
                          className="shrink-0 text-xs font-semibold text-[#E8670A] hover:text-[#c45e09] transition-colors"
                        >
                          Today
                        </button>
                      )}
                    </div>
                  )
                })()}
                {/* water */}
                {quickAction === 'water' && (
                  <>
                    <p className="text-sm text-gray-500 mb-3">
                      {quickActionDate === new Date().toISOString().slice(0, 10) ? "Update today's water" : 'Set water total (oz)'}
                    </p>
                    {quickActionDate === new Date().toISOString().slice(0, 10) && (
                      <div className="grid grid-cols-3 gap-2 mb-3">
                        {['8', '16', '24'].map(oz => (
                          <button
                            key={oz}
                            onClick={() => setQuickValue(oz)}
                            className={`flex-1 py-2.5 rounded-xl text-sm font-bold border-2 transition-colors ${
                              quickValue === oz
                                ? 'bg-[#E8670A] border-[#E8670A] text-white'
                                : 'border-gray-200 text-gray-600 hover:border-[#E8670A]'
                            }`}
                          >
                            +{oz} oz
                          </button>
                        ))}
                      </div>
                    )}
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={quickValue}
                      onChange={e => setQuickValue(e.target.value)}
                      placeholder={quickActionDate === new Date().toISOString().slice(0, 10) ? 'Custom amount (oz)' : 'Total oz for this day'}
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-[#E8670A] mb-3"
                    />
                    {quickActionDate === new Date().toISOString().slice(0, 10) ? (
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => { setQuickWaterMode('add'); submitQuickLog('add') }}
                          disabled={!quickValue || quickSaving}
                          className="w-full bg-[#E8670A] text-white font-bold py-3.5 rounded-2xl text-sm hover:bg-[#c45e09] disabled:opacity-50 transition-colors"
                        >
                          {quickSaving && quickWaterMode === 'add' ? 'Saving...' : 'Add'}
                        </button>
                        <button
                          onClick={() => { setQuickWaterMode('subtract'); submitQuickLog('subtract') }}
                          disabled={!quickValue || quickSaving}
                          className="w-full border-2 border-gray-200 text-gray-600 font-bold py-3.5 rounded-2xl text-sm hover:border-gray-300 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                        >
                          {quickSaving && quickWaterMode === 'subtract' ? 'Saving...' : 'Subtract'}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => submitQuickLog('add')}
                        disabled={!quickValue || quickSaving}
                        className="w-full bg-[#E8670A] text-white font-bold py-3.5 rounded-2xl text-sm hover:bg-[#c45e09] disabled:opacity-50 transition-colors"
                      >
                        {quickSaving ? 'Saving...' : 'Save Water'}
                      </button>
                    )}
                  </>
                )}

                {/* weight */}
                {quickAction === 'weight' && (
                  <>
                    <p className="text-sm text-gray-500 mb-3">Weight (lbs)</p>
                    <input type="number" step="0.1" value={quickValue}
                      onChange={e => setQuickValue(e.target.value)}
                      placeholder="e.g. 145.5"
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-[#E8670A] mb-4"
                    />
                    <button onClick={submitQuickLog} disabled={!quickValue || quickSaving}
                      className="w-full bg-[#E8670A] text-white font-bold py-3.5 rounded-2xl text-sm hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                      {quickSaving ? 'Saving…' : 'Log Weight'}
                    </button>
                  </>
                )}

                {/* steps */}
                {quickAction === 'steps' && (
                  <>
                    <p className="text-sm text-gray-500 mb-3">Steps</p>
                    <input type="number" value={quickValue}
                      onChange={e => setQuickValue(e.target.value)}
                      placeholder="e.g. 8500"
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-[#E8670A] mb-4"
                    />
                    <button onClick={submitQuickLog} disabled={!quickValue || quickSaving}
                      className="w-full bg-[#E8670A] text-white font-bold py-3.5 rounded-2xl text-sm hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                      {quickSaving ? 'Saving…' : 'Log Steps'}
                    </button>
                    <button onClick={clearQuickLog} disabled={quickSaving}
                      className="w-full mt-2 border-2 border-gray-200 text-gray-500 text-sm font-medium py-3 rounded-2xl hover:border-gray-300 hover:text-gray-700 disabled:opacity-50 transition-colors min-h-[44px]">
                      Clear steps (let sync fill)
                    </button>
                  </>
                )}

                {/* sleep */}
                {quickAction === 'sleep' && (
                  <>
                    <p className="text-sm text-gray-500 mb-3">Hours slept</p>
                    <div className="flex gap-2 mb-3">
                      {['6', '7', '8', '9'].map(h => (
                        <button
                          key={h}
                          onClick={() => setQuickValue(h)}
                          className={`flex-1 py-2.5 rounded-xl text-sm font-bold border-2 transition-colors ${
                            quickValue === h
                              ? 'bg-[#E8670A] border-[#E8670A] text-white'
                              : 'border-gray-200 text-gray-600 hover:border-[#E8670A]'
                          }`}
                        >
                          {h}h
                        </button>
                      ))}
                    </div>
                    <input
                      type="number"
                      step="0.5"
                      value={quickValue}
                      onChange={e => setQuickValue(e.target.value)}
                      placeholder="Custom hours (e.g. 7.5)"
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-[#E8670A] mb-4"
                    />
                    <button onClick={submitQuickLog} disabled={!quickValue || quickSaving}
                      className="w-full bg-[#E8670A] text-white font-bold py-3.5 rounded-2xl text-sm hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                      {quickSaving ? 'Saving…' : 'Log Sleep'}
                    </button>
                    <button onClick={clearQuickLog} disabled={quickSaving}
                      className="w-full mt-2 border-2 border-gray-200 text-gray-500 text-sm font-medium py-3 rounded-2xl hover:border-gray-300 hover:text-gray-700 disabled:opacity-50 transition-colors min-h-[44px]">
                      Clear sleep (let sync fill)
                    </button>
                  </>
                )}

                {/* activity */}
                {quickAction === 'activity' && (
                  <>
                    <p className="text-sm text-gray-500 mb-3">What did you do?</p>
                    <div className="flex flex-wrap gap-2 mb-4">
                      {['Walking', 'Running', 'Cycling', 'Strength', 'Cardio', 'Stretching', 'Yoga', 'Other'].map(t => (
                        <button
                          key={t}
                          onClick={() => setQuickActivityType(t)}
                          className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 transition-colors ${
                            quickActivityType === t
                              ? 'bg-[#E8670A] border-[#E8670A] text-white'
                              : 'border-gray-200 text-gray-600 hover:border-[#E8670A]'
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-gray-500 mb-1">Duration (minutes)</p>
                    <input type="number" value={quickActivityDur}
                      onChange={e => setQuickActivityDur(e.target.value)}
                      placeholder="e.g. 30"
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#E8670A] mb-3"
                    />
                    <textarea value={quickActivityNotes}
                      onChange={e => setQuickActivityNotes(e.target.value)}
                      placeholder="Notes (optional)" rows={2}
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#E8670A] resize-none mb-4"
                    />
                    <button onClick={submitQuickActivity} disabled={!quickActivityType || quickSaving}
                      className="w-full bg-[#E8670A] text-white font-bold py-3.5 rounded-2xl text-sm hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                      {quickSaving ? 'Saving…' : 'Log Activity'}
                    </button>
                  </>
                )}

                {/* photo */}
                {quickAction === 'photo' && (
                  <>
                    <p className="text-sm text-gray-500 mb-3">Select angle</p>
                    <div className="flex gap-2 mb-4">
                      {['front', 'back', 'side'].map(a => (
                        <button key={a} onClick={() => setQuickPhotoAngle(a)}
                          className={`flex-1 py-2 rounded-xl text-sm font-bold border-2 transition-colors capitalize ${
                            quickPhotoAngle === a
                              ? 'bg-[#E8670A] border-[#E8670A] text-white'
                              : 'border-gray-200 text-gray-600 hover:border-[#E8670A]'
                          }`}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                    {quickPhotoPreview ? (
                      <div className="relative mb-4">
                        <img src={quickPhotoPreview} alt="Preview" className="w-full max-h-44 object-contain rounded-xl bg-gray-100" />
                        <button
                          onClick={() => { URL.revokeObjectURL(quickPhotoPreview); setQuickPhotoPreview(null); setQuickPhotoFile(null) }}
                          className="absolute top-2 right-2 w-7 h-7 bg-white rounded-full flex items-center justify-center shadow text-gray-600 font-bold"
                        >×</button>
                      </div>
                    ) : (
                      <div className="flex gap-2 mb-4">
                        <button
                          onClick={() => quickPhotoInputRef.current?.click()}
                          className="flex-1 flex flex-col items-center justify-center gap-1.5 border-2 border-gray-200 rounded-xl py-5 text-sm text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors"
                        >
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                          <span className="text-xs font-semibold">Camera</span>
                        </button>
                        <button
                          onClick={() => quickPhotoGalleryRef.current?.click()}
                          className="flex-1 flex flex-col items-center justify-center gap-1.5 border-2 border-gray-200 rounded-xl py-5 text-sm text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors"
                        >
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          <span className="text-xs font-semibold">Gallery</span>
                        </button>
                      </div>
                    )}
                    {/* Camera input */}
                    <input
                      ref={quickPhotoInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={e => {
                        const f = e.target.files?.[0]
                        if (!f) return
                        if (quickPhotoPreview) URL.revokeObjectURL(quickPhotoPreview)
                        setQuickPhotoFile(f)
                        setQuickPhotoPreview(URL.createObjectURL(f))
                      }}
                    />
                    {/* Gallery input */}
                    <input
                      ref={quickPhotoGalleryRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => {
                        const f = e.target.files?.[0]
                        if (!f) return
                        if (quickPhotoPreview) URL.revokeObjectURL(quickPhotoPreview)
                        setQuickPhotoFile(f)
                        setQuickPhotoPreview(URL.createObjectURL(f))
                      }}
                    />
                    <button onClick={submitQuickPhoto} disabled={!quickPhotoFile || quickSaving}
                      className="w-full bg-[#E8670A] text-white font-bold py-3.5 rounded-2xl text-sm hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                      {quickSaving ? 'Uploading…' : 'Upload Photo'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}



