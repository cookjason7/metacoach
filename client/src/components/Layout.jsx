import { useState, useEffect, useCallback, useRef } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { UserButton, useUser, useAuth, useClerk } from '@clerk/clerk-react'
import { API_URL } from '../config.js'
import { Capacitor } from '@capacitor/core'
import { syncAppleHealthToday } from '../hooks/useAppleHealth.js'
import { getLocalDateString } from '../utils/date.js'
import { useOrgBranding } from '../context/OrgBrandingContext.jsx'
import { useViewMode } from '../context/ViewModeContext.jsx'

// Client-facing sidebar nav
const CLIENT_NAV_ITEMS = [
  { to: '/dashboard',    label: 'Dashboard' },
  // label is filled in per-org from the AI coach's name — see clientNavWithLabels.
  { to: '/ai-coach',     label: null, coachLabel: true },
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
  { to: '/staff-chat',    label: 'Team Communication' },
  { to: '/community',     label: 'Community' },
  { to: '/settings',      label: 'Settings' },
]

// 'va' sidebar nav — client onboarding/transition scope only. No Forms,
// Messages, Team Communication, or Community: those all sit behind
// requireStaff on the backend and are never reachable for this role.
const VA_NAV_ITEMS = [
  { to: '/dashboard', label: 'Coaching Dashboard' },
  { to: '/settings',  label: 'Settings' },
]

// "View as client" nav — shown to staff instead of their own STAFF_NAV_ITEMS
// while viewing is true. Deliberately narrower than CLIENT_NAV_ITEMS: only the
// pages this feature actually covers (see ViewModeContext.jsx) — no AI Coach,
// Progress, or Brain Mapping, none of which were audited for view-as
// correctness. Workouts has no entry in CLIENT_NAV_ITEMS at all (clients
// reach it another way today) but is explicitly in scope here, so it's added.
const VIEW_MODE_NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/journal',   label: 'Food Log' },
  { to: '/calendar',  label: 'Calendar' },
  { to: '/messages',  label: 'Messages' },
  { to: '/food-list', label: 'Food List' },
  { to: '/workouts',  label: 'Workouts' },
  { to: '/community', label: 'Community' },
  { to: '/settings',  label: 'Settings' },
]

// Mirrors ADMIN_EMAILS in server/db.js — nav visibility only, the real gate is
// isAdminEmail() on every /api/organizations route.
const SUPER_ADMIN_EMAILS = ['jason@lwcvip.com', 'jason@efcfit.com']

// Progress photo angle sequence — must match this order: Front → Side → Back
const PHOTO_ANGLE_SEQUENCE = ['front', 'side', 'back']

export default function Layout() {
  // ── Blunter diagnostic: fires synchronously during Layout's render body,
  // before any hook is declared. Confirms whether Layout's function is
  // executing fresh code on the device under test at all, independent of
  // any specific effect/hook ordering or timing further down.
  try {
    fetch(`${API_URL}/api/push/app-load-debug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        build:     'layout-render-start',
        platform:  Capacitor.getPlatform(),
        isNative:  String(window.Capacitor?.isNative ?? false),
        href:      window.location.href,
        userAgent: navigator.userAgent,
      }),
    }).catch(() => {})
  } catch {}

  const { primaryColor, sidebarColor, logoUrl, brandName, aiCoachName, coachTitle } = useOrgBranding()
  const { viewing, viewedClient, exitViewMode } = useViewMode()
  const { user, isLoaded }        = useUser()
  const { getToken, isSignedIn }  = useAuth()
  const { signOut }        = useClerk()
  const navigate           = useNavigate()
  const location           = useLocation()
  const mainRef            = useRef(null)
  const [isAdmin,      setIsAdmin]      = useState(false)
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [isOrgAdmin,   setIsOrgAdmin]   = useState(false)
  const [isStaff,      setIsStaff]      = useState(false)
  const [isVa,         setIsVa]         = useState(false) // client onboarding/transition role — scoped staff subset
  const [coachingType, setCoachingType] = useState(null) // 'vip' | 'hybrid' | 'basic' (legacy: 'ai' ≡ 'hybrid') — null until loaded
  const [bloodworkEnabled, setBloodworkEnabled] = useState(false) // per-client flag from /api/users/me
  const [notifCount,   setNotifCount]   = useState(0)
  const [notifOpen,    setNotifOpen]    = useState(false)
  const [notifItems,   setNotifItems]   = useState([])
  const [notifLoading, setNotifLoading] = useState(false)
  const [notifAnchor,  setNotifAnchor]  = useState(null) // {top, left} — see toggleNotifDropdown
  const notifDropdownRef = useRef(null)
  const [katieUnread,  setKatieUnread]  = useState(0)
  const [msgUnread,    setMsgUnread]    = useState(0)
  const [staffUnread,  setStaffUnread]  = useState(0)
  const [pendingFoodsCount, setPendingFoodsCount] = useState(0)
  const [sidebarOpen,  setSidebarOpen]  = useState(false)
  const [quickMenuOpen,       setQuickMenuOpen]       = useState(false)
  const [quickAction,         setQuickAction]         = useState(null)
  const [quickValue,          setQuickValue]          = useState('')
  const [quickNote,           setQuickNote]           = useState('')
  const [quickWaterMode,      setQuickWaterMode]      = useState('add')
  const [quickSaving,         setQuickSaving]         = useState(false)
  const [quickDone,           setQuickDone]           = useState(false)
  const [quickActivityType,   setQuickActivityType]   = useState('')
  const [quickActivityDur,    setQuickActivityDur]    = useState('')
  const [quickActivityNotes,  setQuickActivityNotes]  = useState('')
  const [quickPhotoAngle,     setQuickPhotoAngle]     = useState('front')
  const [quickPhotoFile,      setQuickPhotoFile]      = useState(null)
  const [quickPhotoPreview,   setQuickPhotoPreview]   = useState(null)
  const [quickPhotoSaved,     setQuickPhotoSaved]     = useState(null)  // angle just saved, for transient banner
  const quickPhotoInputRef    = useRef(null)
  const quickPhotoGalleryRef  = useRef(null)
  const overlayPressedRef     = useRef(false) // true only when a pointer press began on the backdrop itself (ghost-click guard)
  const [quickFoodMode, setQuickFoodMode] = useState(null) // 'search'|'barcode'|'photo'|'manual'
  const [quickError,    setQuickError]    = useState(null) // visible error message for failed saves
  // Date chosen in the meal-slot picker (food); defaults to today each time the menu opens
  const [quickLogDate, setQuickLogDate] = useState(() => getLocalDateString())
  // Date chosen in quick-log forms (weight/water/steps/sleep/activity/photo)
  const [quickActionDate, setQuickActionDate] = useState(() => getLocalDateString())

  function resetQuickExtras() {
    setQuickActivityType(''); setQuickActivityDur(''); setQuickActivityNotes('')
    setQuickPhotoAngle('front'); setQuickPhotoFile(null)
    setQuickPhotoPreview(p => { if (p) URL.revokeObjectURL(p); return null })
    setQuickPhotoSaved(null)
    setQuickFoodMode(null)
    setQuickLogDate(getLocalDateString())
    setQuickActionDate(getLocalDateString())
  }

  function openQuickMenu() {
    overlayPressedRef.current = false
    setQuickMenuOpen(true)
    setQuickAction(null)
    setQuickValue('')
    setQuickNote('')
    setQuickWaterMode('add')
    setQuickDone(false)
    setQuickError(null)
    resetQuickExtras()
  }

  // Lets other pages (e.g. Progress) jump straight into a quick-log form for a
  // specific metric/date — used by the missing-entries strip's tap-to-log links.
  useEffect(() => {
    function onOpenQuickLog(e) {
      const { action, date } = e.detail || {}
      if (!action) return
      overlayPressedRef.current = false
      setQuickMenuOpen(true)
      setQuickValue('')
      setQuickNote('')
      setQuickWaterMode('add')
      setQuickDone(false)
      setQuickError(null)
      resetQuickExtras()
      setQuickAction(action)
      if (date) setQuickActionDate(date)
    }
    window.addEventListener('open-quick-log', onOpenQuickLog)
    return () => window.removeEventListener('open-quick-log', onOpenQuickLog)
  }, [])

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
    setQuickNote('')
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
      const todayStr = getLocalDateString()
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
      if (quickNote.trim()) {
        if (quickAction === 'water')  body.water_note  = quickNote.trim()
        if (quickAction === 'sleep')  body.sleep_note  = quickNote.trim()
        if (quickAction === 'weight') body.weight_note = quickNote.trim()
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
      if (quickPhotoInputRef.current)    quickPhotoInputRef.current.value    = ''
      if (quickPhotoGalleryRef.current)  quickPhotoGalleryRef.current.value  = ''
      // Advance through Front → Side → Back; only close after the last angle
      const savedAngle = quickPhotoAngle
      const nextIdx    = PHOTO_ANGLE_SEQUENCE.indexOf(savedAngle) + 1
      if (nextIdx < PHOTO_ANGLE_SEQUENCE.length) {
        // More angles remain — show banner, advance to next angle, stay open
        setQuickPhotoSaved(savedAngle)
        setQuickPhotoAngle(PHOTO_ANGLE_SEQUENCE[nextIdx])
        setTimeout(() => setQuickPhotoSaved(null), 900)
      } else {
        // Last angle (back) saved — show done and close
        setQuickDone(true)
        setTimeout(() => closeQuickMenu(), 1200)
      }
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
      const vaStatus    = data.role === 'va'
      const staffStatus = adminStatus || data.role === 'coach' || data.role === 'staff' || vaStatus
      const superAdminStatus = SUPER_ADMIN_EMAILS.includes((data.email ?? '').toLowerCase())
      setIsAdmin(adminStatus)
      setIsSuperAdmin(superAdminStatus)
      setIsStaff(staffStatus)
      setIsVa(vaStatus)
      // Org-level admin/owner: the org's own 'admin' role, or the org's owner_user_id
      // even when their role is 'coach' — never Jason (he has his own admin views).
      setIsOrgAdmin(!superAdminStatus && (adminStatus || (data.role === 'coach' && data.is_org_owner === true)))
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

  // Desktop-only sidebar bell dropdown (native push has its own working deep-link
  // path via pushService.js's notifyNewCommunityPost — this just closes the gap
  // for the in-app click, which previously only had a count, not individual rows
  // to build a /community?post_id= link from).
  const fetchNotifList = useCallback(async () => {
    setNotifLoading(true)
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/community/notifications`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json()
      setNotifItems(data.notifications ?? [])
    } catch {} finally {
      setNotifLoading(false)
    }
  }, [getToken])

  const toggleNotifDropdown = useCallback(() => {
    if (!notifOpen) {
      // Fixed positioning anchored to the item's live screen rect — the sidebar
      // <nav> has overflow-y-auto, which per spec forces overflow-x to clip too,
      // so an absolutely-positioned panel escaping the sidebar's width would be
      // cut off at its right edge. Fixed positioning sidesteps that entirely.
      const rect = notifDropdownRef.current?.getBoundingClientRect()
      if (rect) setNotifAnchor({ top: rect.top, left: rect.right })
      fetchNotifList()
    }
    setNotifOpen(prev => !prev)
  }, [notifOpen, fetchNotifList])

  const handleNotifClick = useCallback(async (n) => {
    setNotifOpen(false)
    setSidebarOpen(false)
    navigate(`/community?post_id=${n.post_id}`)
    setNotifCount(0)
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/community/notifications/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {}
  }, [getToken, navigate])

  // Click-outside to close, same convention as any other popover in this file.
  // Also closes on scroll — the anchor rect is captured once on open, so letting
  // the sidebar (or page) scroll would otherwise leave the fixed-position panel
  // visually detached from the item it points at.
  useEffect(() => {
    if (!notifOpen) return
    function handleDocClick(e) {
      if (notifDropdownRef.current && !notifDropdownRef.current.contains(e.target)) {
        setNotifOpen(false)
      }
    }
    function handleScroll() { setNotifOpen(false) }
    document.addEventListener('mousedown', handleDocClick)
    document.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handleDocClick)
      document.removeEventListener('scroll', handleScroll, true)
    }
  }, [notifOpen])

  const fetchMsgUnread = useCallback(async () => {
    if (isVa) return // va has no messaging access — server would 403 anyway
    try {
      const token = await getToken()
      // While viewing is true, this must be the VIEWED CLIENT's own unread count,
      // not the staff member's inbox — /api/messages/unread-count is view-as aware
      // (see Build A) and the global fetch patch attaches the header automatically.
      const endpoint = (isStaff && !viewing)
        ? `${API_URL}/api/coach-admin/messaging/unread-count`
        : `${API_URL}/api/messages/unread-count`
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json()
      setMsgUnread(data.unread ?? 0)
    } catch {}
  }, [getToken, isStaff, isVa, viewing])

  const fetchStaffUnread = useCallback(async () => {
    // Team Communication is a staff-internal tool, never part of the client
    // experience — skip it entirely while viewing rather than showing a
    // count for a nav item that isn't even rendered right now.
    if (!isStaff || viewing) return
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/staff-chat/unread`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json()
      setStaffUnread(data.total ?? 0)
    } catch {}
  }, [getToken, isStaff, viewing])

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

  // Same source as the "Coach Foods" tab badge (CoachDashboard.jsx) — pending
  // client-submitted foods awaiting admin review.
  const fetchPendingFoodsCount = useCallback(async () => {
    // Coaching Dashboard's pending-review badge — staff-only, and that nav item
    // isn't shown while viewing (VIEW_MODE_NAV_ITEMS has no Coaching Dashboard).
    if (!isStaff || isVa || viewing) return // va has no access to client-foods review — stays staff-only
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/admin/client-foods?status=pending`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json()
      setPendingFoodsCount(Array.isArray(data) ? data.length : 0)
    } catch {}
  }, [getToken, isStaff, isVa, viewing])

  useEffect(() => {
    fetchRole()
  }, [fetchRole])

  // Defense-in-depth: if Layout ever persists across a sign-out/sign-in cycle
  // by the same Clerk account (it currently doesn't — ProtectedLayout unmounts
  // it whenever isSignedIn goes false), force a fresh /api/users/me fetch on
  // the sign-in transition rather than trusting whatever role state is already
  // in memory from the prior session.
  const prevSignedInRef = useRef(isSignedIn)
  useEffect(() => {
    const freshSignIn = isSignedIn === true && prevSignedInRef.current !== true
    prevSignedInRef.current = isSignedIn
    if (freshSignIn) fetchRole()
  }, [isSignedIn, fetchRole])

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

  // ── Android/iOS push notification registration ─────────────────────────────
  // Runs once the user is authenticated. Non-blocking — all errors are warnings.
  //
  // @capacitor/push-notifications is imported dynamically (not at module top
  // level) and only after Capacitor.isPluginAvailable('PushNotifications')
  // confirms the native bridge has finished injecting. registerPlugin() inside
  // @capacitor/core captures the platform/native-headers state ONCE, synchronously,
  // at the moment the plugin module is first imported — if that happens before the
  // native bridge has injected into the WebView (a real race in this app's
  // server.url remote-content mode, since the web bundle is fetched over the
  // network rather than loaded from a bundled local asset), the plugin proxy is
  // permanently stuck treating the device as "web" for the rest of that page
  // load, and every later call throws "plugin is not implemented" — no amount
  // of retrying checkPermissions()/register() afterwards fixes it. Deferring the
  // import itself until isPluginAvailable() (which re-checks live on every call)
  // confirms readiness avoids the race entirely.
  const pushTokenRef = useRef(null)
  useEffect(() => {
    // getToken() needs a live Clerk token, which POST /api/push/debug requires
    // (requireAuth()). Clerk can genuinely need a beat to initialize in the
    // WebView right at effect-mount — one retry after a short delay gives it
    // that beat instead of giving up on the very first attempt.
    const getTokenRetried = async () => {
      try {
        const t = await getToken()
        if (t) return t
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500))
      try {
        return await getToken()
      } catch (err) {
        console.warn('[push] sendDebug getToken() retry also failed', String(err?.message ?? err))
        return null
      }
    }

    // Fire-and-forget diagnostic ping — never includes the FCM token value.
    // Every failure mode is logged to console rather than swallowed: a fetch()
    // call resolving with a non-ok status (e.g. a 401 from an expired/missing
    // Clerk token) does NOT throw, so a bare `catch {}` here would silently
    // discard exactly the failures most worth knowing about.
    const sendDebug = async (step, value) => {
      const body = { step }
      if (value !== undefined) body.value = String(value)

      const clerkToken = await getTokenRetried()
      if (!clerkToken) {
        console.warn('[push] sendDebug has no Clerk token after retry — step not reported', step)
        return
      }

      try {
        const res = await fetch(`${API_URL}/api/push/debug`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${clerkToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          console.warn('[push] sendDebug POST not ok', { step, status: res.status })
        }
      } catch (err) {
        console.warn('[push] sendDebug fetch failed', { step, error: String(err?.message ?? err) })
      }
    }

    // Unconditional — fires on every run of this effect, before the isLoaded/user
    // gate below, so we can tell "effect never ran" apart from "effect ran but
    // bailed because auth wasn't ready yet." Uses the unauthenticated
    // /api/push/app-load-debug endpoint rather than sendDebug()/api/push/debug —
    // this is the single most critical log point (confirming the effect runs
    // at all), and it must not depend on getToken() having already resolved at
    // this exact instant, which is the one thing we can't guarantee this early.
    try {
      fetch(`${API_URL}/api/push/app-load-debug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          build:     'push-effect-start',
          platform:  Capacitor.getPlatform(),
          isNative:  String(window.Capacitor?.isNative ?? false),
          href:      'push-effect',
          userAgent: `isLoaded=${isLoaded} hasUser=${!!user}`,
        }),
      }).catch(() => {})
    } catch {}

    if (!isLoaded || !user) return

    let cancelled = false
    let regListener = null
    let errListener = null
    let actionListener = null
    let platform = null // set once the plugin is confirmed available, below

    // Poll the live Capacitor bridge state rather than trusting a one-shot
    // check — isPluginAvailable() re-reads window.Capacitor.PluginHeaders on
    // every call, so it correctly reflects the bridge finishing injection
    // after this effect has already started running.
    const waitForPushPlugin = async (timeoutMs = 5000, intervalMs = 100) => {
      const start = Date.now()
      while (!cancelled && Date.now() - start < timeoutMs) {
        if (window.Capacitor?.isPluginAvailable?.('PushNotifications')) return true
        await new Promise(resolve => setTimeout(resolve, intervalMs))
      }
      return false
    }

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
      const pluginReady = await waitForPushPlugin()
      if (cancelled) return

      if (!pluginReady) {
        // Always log the timeout, regardless of what platform is detected —
        // a false 'web' reading on a real native device is exactly the kind
        // of thing this is meant to catch, not silently swallow.
        const platformNow = Capacitor.getPlatform()
        sendDebug('bridge-ready-timeout', `platform=${platformNow}`)

        if (platformNow === 'web') {
          // Expected — plain browser tab, not the native app. No push support here.
          return
        }
        // Native platform, but the bridge never confirmed the plugin — worth tracing.
        console.warn('[push] native bridge never became ready — push unavailable this session')
        return
      }

      platform = Capacitor.getPlatform()
      sendDebug('native-detected', `platform=${platform}`)

      try {
        // Import only now — importing at module load time registers the plugin's
        // Capacitor proxy before we can guarantee the bridge is ready (see comment
        // above this effect). isPluginAvailable() having just returned true means
        // this import resolves against a bridge that's already live.
        const { PushNotifications } = await import('@capacitor/push-notifications')

        // Fires when the user taps a notification (from tray or in-app banner).
        // The server attaches a deep-link url on whichever notification type sent
        // it (see notifyNewDirectMessage / notifyNewCommunityPost in
        // pushService.js) so tapping opens the specific thread or post instead of
        // just landing on the Dashboard. Routed generically — no per-type cases.
        //
        // Attached FIRST, before the registration listeners: on a cold start the
        // tap event is fired by the native layer as soon as the bridge is live and
        // is NOT replayed for listeners that attach later, so every extra bridge
        // round-trip ahead of this one is a window where the deep link is lost and
        // the app just lands on the default page. Warm start (app already open in
        // the webview) needs nothing extra — navigate() routes in place.
        actionListener = await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const url = action?.notification?.data?.url
          if (url) navigate(url)
        })

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
      actionListener?.remove()
    }
  }, [isLoaded, user, getToken, navigate])

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
    const id = setInterval(fetchKatieUnread, 15_000)
    return () => clearInterval(id)
  }, [fetchKatieUnread])

  useEffect(() => {
    const handler = () => fetchKatieUnread()
    window.addEventListener('katie-unread-refresh', handler)
    return () => window.removeEventListener('katie-unread-refresh', handler)
  }, [fetchKatieUnread])

  useEffect(() => {
    fetchMsgUnread()
    const id = setInterval(fetchMsgUnread, 60_000)
    return () => clearInterval(id)
  }, [fetchMsgUnread])

  useEffect(() => {
    fetchStaffUnread()
    const id = setInterval(fetchStaffUnread, 60_000)
    return () => clearInterval(id)
  }, [fetchStaffUnread])

  useEffect(() => {
    fetchPendingFoodsCount()
    const id = setInterval(fetchPendingFoodsCount, 60_000)
    return () => clearInterval(id)
  }, [fetchPendingFoodsCount])

  // Scroll desktop main content to top on every route change.
  // The <main> element persists across navigations (Layout never unmounts),
  // so its scrollTop is preserved without this — leaving a blank space above
  // the content when the user navigates to /dashboard from a scrolled page.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [location.pathname])

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
  // The AI coach entry takes its label from the org's configured coach name via
  // coachTitle, rather than string-replacing 'Katie' inside a hardcoded label —
  // that older approach turned an org name of "Coach Alex" into "Coach Coach Alex".
  const clientNavWithLabels = (isNonVipClient
    ? baseClientNav.map(item => item.label === 'Messages' ? { ...item, label: 'Support' } : item)
    : baseClientNav
  ).map(item => item.coachLabel ? { ...item, label: coachTitle } : item)

  // Org-level admins/owners (not Jason) get their own fixed nav — no LWC-internal
  // tools (Usage Analytics, Workout Builder Test), but Katie Corrections stays
  // since org owners do need to review their own AI coach's corrections.
  const orgAdminNavItems = [
    { to: '/org/dashboard',           label: 'Dashboard' },
    { to: '/org/setup',               label: 'My Organization' },
    { to: '/messages',                label: 'Messages' },
    { to: '/admin/forms',             label: 'Forms' },
    { to: '/staff-chat',              label: 'Team Communication' },
    { to: '/community',               label: 'Community' },
    { to: '/admin/katie-corrections', label: `${aiCoachName} Corrections` },
    { to: '/settings',                label: 'Settings' },
  ]

  // Super-admin gets extra "Usage Analytics", "Workout Builder Test", and
  // "Organizations" nav entries — LWC-internal tools, never shown to org admins.
  // While viewing is true, staff see the scoped view-mode nav instead of their
  // own staff nav, regardless of role — this is what makes the sidebar itself
  // "the actual client UI" the task calls for, not just each page's content.
  const navItems = viewing
    ? VIEW_MODE_NAV_ITEMS
    : isStaff
      ? isAdmin
        ? (isOrgAdmin
            ? orgAdminNavItems
            : [
                ...STAFF_NAV_ITEMS,
                { to: '/admin/usage', label: 'Usage Analytics' },
                { to: '/admin/katie-corrections', label: `${aiCoachName} Corrections` },
                { to: '/admin/workout-builder-test', label: 'Workout Builder Test' },
                ...(isSuperAdmin ? [{ to: '/admin/organizations', label: 'Organizations' }] : []),
              ])
        : (isOrgAdmin ? orgAdminNavItems : (isVa ? VA_NAV_ITEMS : STAFF_NAV_ITEMS))
      : clientNavWithLabels

  // Mobile drawer hides items already in the client bottom nav. Matched by
  // route path rather than label text since the "Coach Katie" label text
  // varies with the org's configured AI coach name.
  const mobileBottomNavPaths = isBasicClient
    ? new Set(['/dashboard', '/ai-coach', '/journal', '/messages'])
    : isNonVipClient
      ? new Set(['/dashboard', '/ai-coach', '/journal', '/community'])
      : new Set(['/dashboard', '/journal', '/messages', '/community', '/calendar'])
  const mobileNavItems = (isStaff && !viewing) ? navItems : navItems.filter(i => !mobileBottomNavPaths.has(i.to))

  function buildSidebarContent(items, isMobile = false) { return (
    <>
      {/* Logo */}
      <div className="flex justify-center mt-6 mb-5 px-3">
        <img
          src={logoUrl}
          alt={brandName}
          className={isMobile ? "w-[59px] h-auto block" : "w-[102px] h-auto block"}
        />
      </div>

      {/* Nav */}
      <nav className="flex-1 min-h-0 overflow-y-auto px-3 space-y-0.5">
        {items.map(({ to, href, label, matchPath, matchSearch }) => {
          if (href) {
            return (
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
            )
          }

          // Bell dropdown only replaces the plain badge dot on the real desktop
          // sidebar — mobile drawer and native push both already have a working
          // (or out-of-scope) path and are left exactly as before.
          const isCommunityDesktop = label === 'Community' && !isMobile

          const navLink = (
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
                    ? 'text-white'
                    : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`
              }}
              style={({ isActive }) => {
                const active = matchSearch
                  ? location.pathname === matchPath && location.search.includes(matchSearch)
                  : isActive && !(matchPath === undefined && label === 'Community' && location.search.includes('tab=mindset'))
                return active ? { background: 'var(--color-accent)' } : undefined
              }}
            >
              {label}
              {label === 'Community' && notifCount > 0 && (
                isCommunityDesktop ? (
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`${notifCount} unread community notification${notifCount === 1 ? '' : 's'}`}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleNotifDropdown() }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleNotifDropdown() }
                    }}
                    className="ml-auto flex items-center justify-center w-4 h-4 rounded-full bg-red-500 hover:bg-red-600 transition-colors cursor-pointer"
                  >
                    <span className="w-2 h-2 bg-white rounded-full" />
                  </span>
                ) : (
                  <span className="ml-auto w-2 h-2 bg-red-500 rounded-full" />
                )
              )}
              {to === '/ai-coach' && katieUnread > 0 && (
                <span className="ml-auto flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-white text-[10px] font-bold px-1" style={{ background: 'var(--color-accent)' }}>
                  {katieUnread}
                </span>
              )}
              {(label === 'Messages' || label === 'Support') && msgUnread > 0 && (
                <span className="ml-auto flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-white text-[10px] font-bold px-1" style={{ background: 'var(--color-accent)' }}>
                  {msgUnread}
                </span>
              )}
              {label === 'Team Communication' && staffUnread > 0 && (
                <span className="ml-auto flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-white text-[10px] font-bold px-1" style={{ background: 'var(--color-accent)' }}>
                  {staffUnread}
                </span>
              )}
              {label === 'Coaching Dashboard' && pendingFoodsCount > 0 && !isVa && (
                <span
                  className="ml-auto flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-white text-[10px] font-bold px-1 bg-amber-500"
                  title={`${pendingFoodsCount} pending client food${pendingFoodsCount === 1 ? '' : 's'} awaiting review`}
                >
                  {pendingFoodsCount}
                </span>
              )}
            </NavLink>
          )

          if (!isCommunityDesktop) return navLink

          return (
            <div key={to} ref={notifDropdownRef}>
              {navLink}
              {notifOpen && notifAnchor && (
                <div
                  className="fixed w-80 max-h-[28rem] overflow-y-auto rounded-lg shadow-xl bg-white border border-gray-200 z-50 text-sm"
                  style={{ top: notifAnchor.top, left: notifAnchor.left + 8 }}
                >
                  <div className="px-4 py-2.5 border-b border-gray-100 font-semibold text-gray-700">
                    Community notifications
                  </div>
                  {notifLoading ? (
                    <div className="px-4 py-6 text-center text-gray-400">Loading…</div>
                  ) : notifItems.length === 0 ? (
                    <div className="px-4 py-6 text-center text-gray-400">No unread notifications</div>
                  ) : (
                    notifItems.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => handleNotifClick(n)}
                        className="w-full text-left px-4 py-3 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors"
                      >
                        <p className="text-gray-800 line-clamp-2">{n.label}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </p>
                      </button>
                    ))
                  )}
                  <button
                    type="button"
                    onClick={() => { setNotifOpen(false); navigate('/community') }}
                    className="w-full text-center px-4 py-2.5 text-xs font-medium hover:bg-gray-50 transition-colors"
                    style={{ color: 'var(--color-accent)' }}
                  >
                    View all in Community
                  </button>
                </div>
              )}
            </div>
          )
        })}
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
      <div className="px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:pb-4">
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

  function handleExitViewMode() {
    const clientId = viewedClient?.id
    exitViewMode()
    navigate(clientId ? `/admin/clients/${clientId}` : '/admin/clients')
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">

      {/* Persistent view-mode banner — visible above every page while viewing is
          true. Read-only is enforced server-side (blockWritesInViewMode); this is
          purely so staff never forget which identity they're browsing as. */}
      {viewing && (
        <div className="shrink-0 z-[90] flex items-center justify-between gap-3 px-4 py-2.5 bg-amber-500 text-white text-sm">
          <span className="font-medium truncate">
            👁️ Viewing as {viewedClient?.name ?? 'client'} — read only
          </span>
          <button
            onClick={handleExitViewMode}
            className="shrink-0 px-3 py-1.5 min-h-[44px] sm:min-h-0 rounded-lg bg-white/20 hover:bg-white/30 font-semibold text-xs transition-colors"
          >
            Exit
          </button>
        </div>
      )}

    <div className="flex flex-1 min-h-0">

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-60 flex-shrink-0 flex-col" style={{ background: 'var(--color-sidebar)' }}>
        {buildSidebarContent(navItems)}
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-[60] flex">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="relative z-[61] h-[100dvh] max-h-[100dvh] w-60 flex flex-col flex-shrink-0" style={{ background: 'var(--color-sidebar)' }}>
            {buildSidebarContent(mobileNavItems, true)}
          </aside>
        </div>
      )}

      <main ref={mainRef} className="flex-1 overflow-y-auto px-4 pt-[calc(1rem+env(safe-area-inset-top))] lg:p-8 pb-[calc(7.5rem+env(safe-area-inset-bottom))] lg:pb-8">
        {/* Mobile hamburger */}
        <button
          className="lg:hidden relative z-[55] mb-4 flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-200 transition-colors touch-manipulation"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open menu"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <Outlet />
      </main>

    </div>

      {/* Mobile bottom nav
            Staff:       Coaching | Clients | Messages | Community
            Basic:       Home | Food Log | Katie | Support
            AI/Hybrid:   Home | Food Log | Katie | Community
            VIP:         Home | Calendar | Food Log | Messages | Community  */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-gray-200 flex pb-[env(safe-area-inset-bottom)]">
        {/* While viewing is true, isVa/isStaff still reflect the real staff member —
            skip both branches so this falls through to the VIP-style client bar
            (isBasicClient/isNonVipClient are also always false for staff, viewing
            or not, so that's exactly where it lands). */}
        {((isVa && !viewing) ? [
          // VA bottom nav: onboarding-only scope, no Messages/Community. No
          // pending-foods badge either — that stays a staff-only signal.
          { to: '/dashboard',     label: 'Coaching',  badge: false,             icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" /> },
          { to: '/admin/clients', label: 'Clients',   badge: false,             icon: <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
          { to: '/settings',      label: 'Settings',  badge: false,             icon: <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /> },
        ] : (isStaff && !viewing) ? [
          // Staff bottom nav
          { to: '/dashboard',     label: 'Coaching',  badge: pendingFoodsCount > 0, icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" /> },
          { to: '/admin/clients', label: 'Clients',   badge: false,             icon: <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
          { to: '/messages',      label: 'Messages',  badge: msgUnread > 0,     icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /> },
          { to: '/community',     label: 'Community', badge: notifCount > 0,    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
        ] : isBasicClient ? [
          // Basic client bottom nav: Home | Food Log | Katie | Support  (no Community)
          { to: '/dashboard', label: 'Home',     badge: false,             icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /> },
          { to: '/journal',   label: 'Food Log', badge: false,             icon: <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /> },
          { to: '/ai-coach',  label: aiCoachName,    badge: katieUnread > 0,   icon: <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /> },
          { to: '/messages',  label: 'Support',  badge: msgUnread > 0,     icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /> },
        ] : isNonVipClient ? [
          // AI / Hybrid client bottom nav: Home | Food Log | Katie | Community
          { to: '/dashboard', label: 'Home',      badge: false,            icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /> },
          { to: '/journal',   label: 'Food Log',  badge: false,            icon: <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /> },
          { to: '/ai-coach',  label: aiCoachName,     badge: katieUnread > 0,  icon: <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /> },
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
                isActive ? '' : 'text-gray-400'
              }`
            }
            style={({ isActive }) => (isActive ? { color: 'var(--color-accent)' } : undefined)}
          >
            <div className="relative">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                {icon}
              </svg>
              {badge && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full" style={{ background: 'var(--color-accent)' }} />
              )}
            </div>
            <span className="max-w-full truncate">{label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Floating quick-log button — client only, above bottom nav on the right */}
      {!isStaff && !quickMenuOpen && (
        <button
          className="lg:hidden fixed right-4 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-40 flex flex-col items-center gap-1 active:scale-95 transition-transform"
          onClick={openQuickMenu}
          aria-label="Quick log"
        >
          <div className="w-14 h-14 rounded-full shadow-lg flex items-center justify-center" style={{ background: 'var(--color-accent)' }}>
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <span className="text-[11px] font-semibold leading-none drop-shadow-sm" style={{ color: 'var(--color-accent)' }}>Log</span>
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
                    if (quickAction) { setQuickAction(null); setQuickValue(''); setQuickNote(''); setQuickDone(false); setQuickError(null); resetQuickExtras() }
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
                {/* Date selector — lets users log to today, tomorrow, or a past date */}
                <div>
                  <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2">
                    Log date
                  </label>
                  <div className="flex gap-2 mb-2 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0" style={{ WebkitOverflowScrolling: 'touch' }}>
                    {Array.from({ length: 7 }, (_, i) => {
                      const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000)
                      const value = getLocalDateString(d)
                      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short' })
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setQuickLogDate(value)}
                          className={`shrink-0 min-w-[44px] min-h-[44px] px-3.5 rounded-xl text-sm font-semibold transition-colors border whitespace-nowrap ${
                            quickLogDate === value
                              ? 'text-white'
                              : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-orange-50'
                          }`}
                          style={quickLogDate === value ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : undefined}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={quickLogDate}
                      max={getLocalDateString(new Date(Date.now() + 6 * 24 * 60 * 60 * 1000))}
                      min={getLocalDateString(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))}
                      onChange={e => setQuickLogDate(e.target.value || getLocalDateString())}
                      className="flex-1 min-h-[44px] border border-gray-300 rounded-xl px-3 py-2.5 text-sm text-gray-700 focus:outline-none bg-white"
                      onFocus={e => { e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent)' }}
                      onBlur={e => { e.currentTarget.style.boxShadow = 'none' }}
                    />
                    {quickLogDate !== getLocalDateString() && (
                      <button
                        onClick={() => setQuickLogDate(getLocalDateString())}
                        className="shrink-0 text-xs font-semibold transition-colors px-2"
                        style={{ color: 'var(--color-accent)' }}
                        onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-hover)' }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-accent)' }}
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
                        className="flex items-center gap-3 bg-gray-50 hover:bg-orange-50 border border-gray-200 rounded-2xl px-4 py-4 transition-all min-h-[60px]"
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = '' }}
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
                  const todayStr = getLocalDateString()
                  const minStr   = getLocalDateString(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
                  return (
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-xs font-medium text-gray-500 shrink-0">Date</span>
                      <input
                        type="date"
                        value={quickActionDate}
                        min={minStr}
                        max={todayStr}
                        onChange={e => setQuickActionDate(e.target.value || todayStr)}
                        className="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm text-gray-700 focus:outline-none bg-white"
                        onFocus={e => { e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent)' }}
                        onBlur={e => { e.currentTarget.style.boxShadow = 'none' }}
                      />
                      {quickActionDate !== todayStr && (
                        <button
                          onClick={() => setQuickActionDate(todayStr)}
                          className="shrink-0 text-xs font-semibold transition-colors"
                          style={{ color: 'var(--color-accent)' }}
                          onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-hover)' }}
                          onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-accent)' }}
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
                      {quickActionDate === getLocalDateString() ? "Update today's water" : 'Set water total (oz)'}
                    </p>
                    {quickActionDate === getLocalDateString() && (
                      <div className="grid grid-cols-3 gap-2 mb-3">
                        {['8', '16', '24'].map(oz => (
                          <button
                            key={oz}
                            onClick={() => setQuickValue(oz)}
                            className={`flex-1 py-2.5 rounded-xl text-sm font-bold border-2 transition-colors ${
                              quickValue === oz
                                ? 'text-white'
                                : 'border-gray-200 text-gray-600'
                            }`}
                            style={quickValue === oz ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : undefined}
                            onMouseEnter={e => { if (quickValue !== oz) e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                            onMouseLeave={e => { if (quickValue !== oz) e.currentTarget.style.borderColor = '' }}
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
                      placeholder={quickActionDate === getLocalDateString() ? 'Custom amount (oz)' : 'Total oz for this day'}
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none mb-3"
                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = '' }}
                    />
                    <input
                      type="text"
                      value={quickNote}
                      onChange={e => setQuickNote(e.target.value)}
                      placeholder="Note (optional)"
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none mb-3"
                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = '' }}
                    />
                    {quickActionDate === getLocalDateString() ? (
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => { setQuickWaterMode('add'); submitQuickLog('add') }}
                          disabled={!quickValue || quickSaving}
                          className="w-full text-white font-bold py-3.5 rounded-2xl text-sm disabled:opacity-50 transition-colors"
                      style={{ background: 'var(--color-accent)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
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
                        className="w-full text-white font-bold py-3.5 rounded-2xl text-sm disabled:opacity-50 transition-colors"
                      style={{ background: 'var(--color-accent)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
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
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none mb-3"
                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = '' }}
                    />
                    <input
                      type="text"
                      value={quickNote}
                      onChange={e => setQuickNote(e.target.value)}
                      placeholder="Note (optional)"
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none mb-4"
                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = '' }}
                    />
                    <button onClick={submitQuickLog} disabled={!quickValue || quickSaving}
                      className="w-full text-white font-bold py-3.5 rounded-2xl text-sm disabled:opacity-50 transition-colors"
                      style={{ background: 'var(--color-accent)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}>
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
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none mb-4"
                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = '' }}
                    />
                    <button onClick={submitQuickLog} disabled={!quickValue || quickSaving}
                      className="w-full text-white font-bold py-3.5 rounded-2xl text-sm disabled:opacity-50 transition-colors"
                      style={{ background: 'var(--color-accent)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}>
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
                              ? 'text-white'
                              : 'border-gray-200 text-gray-600'
                          }`}
                          style={quickValue === h ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : undefined}
                          onMouseEnter={e => { if (quickValue !== h) e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                          onMouseLeave={e => { if (quickValue !== h) e.currentTarget.style.borderColor = '' }}
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
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none mb-3"
                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = '' }}
                    />
                    <input
                      type="text"
                      value={quickNote}
                      onChange={e => setQuickNote(e.target.value)}
                      placeholder="Note (optional)"
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none mb-4"
                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = '' }}
                    />
                    <button onClick={submitQuickLog} disabled={!quickValue || quickSaving}
                      className="w-full text-white font-bold py-3.5 rounded-2xl text-sm disabled:opacity-50 transition-colors"
                      style={{ background: 'var(--color-accent)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}>
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
                              ? 'text-white'
                              : 'border-gray-200 text-gray-600'
                          }`}
                          style={quickActivityType === t ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : undefined}
                          onMouseEnter={e => { if (quickActivityType !== t) e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                          onMouseLeave={e => { if (quickActivityType !== t) e.currentTarget.style.borderColor = '' }}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-gray-500 mb-1">Duration (minutes)</p>
                    <input type="number" value={quickActivityDur}
                      onChange={e => setQuickActivityDur(e.target.value)}
                      placeholder="e.g. 30"
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none mb-3"
                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = '' }}
                    />
                    <textarea value={quickActivityNotes}
                      onChange={e => setQuickActivityNotes(e.target.value)}
                      placeholder="Notes (optional)" rows={2}
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none resize-none mb-4"
                      onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = '' }}
                    />
                    <button onClick={submitQuickActivity} disabled={!quickActivityType || quickSaving}
                      className="w-full text-white font-bold py-3.5 rounded-2xl text-sm disabled:opacity-50 transition-colors"
                      style={{ background: 'var(--color-accent)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}>
                      {quickSaving ? 'Saving…' : 'Log Activity'}
                    </button>
                  </>
                )}

                {/* photo */}
                {quickAction === 'photo' && (
                  <>
                    {/* Step indicator */}
                    {(() => {
                      const stepIdx = PHOTO_ANGLE_SEQUENCE.indexOf(quickPhotoAngle)
                      return (
                        <p className="text-sm text-gray-500 mb-3">
                          Step {stepIdx + 1} of {PHOTO_ANGLE_SEQUENCE.length} — <span className="font-semibold capitalize">{quickPhotoAngle}</span>
                        </p>
                      )
                    })()}
                    {/* Success banner for most-recently saved angle */}
                    {quickPhotoSaved && (
                      <div className="mb-3 px-3 py-2 bg-green-50 border border-green-200 rounded-xl text-xs font-semibold text-green-700 flex items-center gap-1.5">
                        <span>✓</span>
                        <span className="capitalize">{quickPhotoSaved}</span> photo saved!
                      </div>
                    )}
                    <div className="flex gap-2 mb-4">
                      {PHOTO_ANGLE_SEQUENCE.map(a => (
                        <button key={a} onClick={() => setQuickPhotoAngle(a)}
                          className={`flex-1 py-2 rounded-xl text-sm font-bold border-2 transition-colors capitalize ${
                            quickPhotoAngle === a
                              ? 'text-white'
                              : 'border-gray-200 text-gray-600'
                          }`}
                          style={quickPhotoAngle === a ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : undefined}
                          onMouseEnter={e => { if (quickPhotoAngle !== a) e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                          onMouseLeave={e => { if (quickPhotoAngle !== a) e.currentTarget.style.borderColor = '' }}
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
                          className="flex-1 flex flex-col items-center justify-center gap-1.5 border-2 border-gray-200 rounded-xl py-5 text-sm text-gray-600 transition-colors"
                          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-accent)'; e.currentTarget.style.color = 'var(--color-accent)' }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.color = '' }}
                        >
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                          <span className="text-xs font-semibold">Camera</span>
                        </button>
                        <button
                          onClick={() => quickPhotoGalleryRef.current?.click()}
                          className="flex-1 flex flex-col items-center justify-center gap-1.5 border-2 border-gray-200 rounded-xl py-5 text-sm text-gray-600 transition-colors"
                          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-accent)'; e.currentTarget.style.color = 'var(--color-accent)' }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.color = '' }}
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
                      className="w-full text-white font-bold py-3.5 rounded-2xl text-sm disabled:opacity-50 transition-colors"
                      style={{ background: 'var(--color-accent)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}>
                      {quickSaving ? 'Uploading…'
                        : PHOTO_ANGLE_SEQUENCE.indexOf(quickPhotoAngle) < PHOTO_ANGLE_SEQUENCE.length - 1
                          ? 'Save & Continue →'
                          : 'Save & Finish'}
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



