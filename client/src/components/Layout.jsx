import { useState, useEffect, useCallback, useRef } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { UserButton, useUser, useAuth, useClerk } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

// Client-facing sidebar nav
const CLIENT_NAV_ITEMS = [
  { to: '/dashboard',    label: 'Dashboard' },
  { to: '/ai-coach',     label: 'Coach Katie' },
  { to: '/journal',      label: 'Food Log' },
  { to: '/calendar',     label: 'Calendar' },
  { to: '/messages',     label: 'Messages' },
  { to: '/food-list',    label: 'Food List' },
  { to: '/community',    label: 'Community' },
  { to: '/settings',     label: 'Settings' },
]

// Coach / admin sidebar nav — no personal food/fitness items
const STAFF_NAV_ITEMS = [
  { to: '/dashboard',     label: 'Coaching Dashboard' },
  { to: '/admin/forms',   label: 'Forms' },
  { to: '/messages',      label: 'Messages' },
  { to: '/community',     label: 'Community' },
  { to: '/workouts',      label: 'Workouts' },
  { to: '/settings',      label: 'Settings' },
]

const SIDEBAR_BG = '#0F1E35'

export default function Layout() {
  const { user, isLoaded } = useUser()
  const { getToken }       = useAuth()
  const { signOut }        = useClerk()
  const navigate           = useNavigate()
  const [isAdmin,      setIsAdmin]      = useState(false)
  const [isStaff,      setIsStaff]      = useState(false)
  const [notifCount,   setNotifCount]   = useState(0)
  const [katieUnread,  setKatieUnread]  = useState(0)
  const [msgUnread,    setMsgUnread]    = useState(0)
  const [sidebarOpen,  setSidebarOpen]  = useState(false)
  const [quickMenuOpen,       setQuickMenuOpen]       = useState(false)
  const [quickAction,         setQuickAction]         = useState(null)
  const [quickValue,          setQuickValue]          = useState('')
  const [quickSaving,         setQuickSaving]         = useState(false)
  const [quickDone,           setQuickDone]           = useState(false)
  const [quickActivityType,   setQuickActivityType]   = useState('')
  const [quickActivityDur,    setQuickActivityDur]    = useState('')
  const [quickActivityNotes,  setQuickActivityNotes]  = useState('')
  const [quickPhotoAngle,     setQuickPhotoAngle]     = useState('front')
  const [quickPhotoFile,      setQuickPhotoFile]      = useState(null)
  const [quickPhotoPreview,   setQuickPhotoPreview]   = useState(null)
  const quickPhotoInputRef = useRef(null)

  function resetQuickExtras() {
    setQuickActivityType(''); setQuickActivityDur(''); setQuickActivityNotes('')
    setQuickPhotoAngle('front'); setQuickPhotoFile(null)
    setQuickPhotoPreview(p => { if (p) URL.revokeObjectURL(p); return null })
  }

  function openQuickMenu() {
    setQuickMenuOpen(true)
    setQuickAction(null)
    setQuickValue('')
    setQuickDone(false)
    resetQuickExtras()
  }

  function closeQuickMenu() {
    setQuickMenuOpen(false)
    setQuickAction(null)
    setQuickValue('')
    setQuickDone(false)
    resetQuickExtras()
  }

  async function submitQuickLog() {
    if (!quickValue || quickSaving) return
    setQuickSaving(true)
    try {
      const token = await getToken()
      let body = {}
      if (quickAction === 'water') {
        const todayRes = await fetch(`${API_URL}/api/daily-logs/today`, { headers: { Authorization: `Bearer ${token}` } })
        const today = todayRes.ok ? await todayRes.json() : {}
        body.water_oz = (today.water_oz ?? 0) + Number(quickValue)
      } else if (quickAction === 'weight') {
        body.weight_lbs = Number(quickValue)
      } else if (quickAction === 'steps') {
        body.steps = Number(quickValue)
      } else if (quickAction === 'sleep') {
        body.sleep_minutes = Math.round(Number(quickValue) * 60)
      }
      await fetch(`${API_URL}/api/daily-logs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setQuickDone(true)
      setTimeout(() => closeQuickMenu(), 1200)
    } catch {}
    finally { setQuickSaving(false) }
  }

  async function submitQuickActivity() {
    if (!quickActivityType || quickSaving) return
    setQuickSaving(true)
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/workouts/log-activity`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_type: quickActivityType,
          duration_minutes: quickActivityDur ? Number(quickActivityDur) : null,
          notes: quickActivityNotes || null,
        }),
      })
      setQuickDone(true)
      setTimeout(() => closeQuickMenu(), 1200)
    } catch {}
    finally { setQuickSaving(false) }
  }

  async function submitQuickPhoto() {
    if (!quickPhotoFile || quickSaving) return
    setQuickSaving(true)
    try {
      const token = await getToken()
      const body = new FormData()
      body.append('photo', quickPhotoFile)
      body.append('angle', quickPhotoAngle)
      await fetch(`${API_URL}/api/progress-photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      })
      if (quickPhotoPreview) URL.revokeObjectURL(quickPhotoPreview)
      setQuickPhotoFile(null)
      setQuickPhotoPreview(null)
      if (quickPhotoInputRef.current) quickPhotoInputRef.current.value = ''
      setQuickDone(true)
      setTimeout(() => setQuickDone(false), 1200)
    } catch {}
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
      const adminStatus = data.role === 'admin'
      const staffStatus = adminStatus || data.role === 'coach'
      // Debug logging — verify admin status loads correctly
      console.log('[layout]',
        'email=', user?.primaryEmailAddress?.emailAddress,
        'role=', data.role,
        'isAdmin=', adminStatus,
        'isStaff=', staffStatus,
      )
      setIsAdmin(adminStatus)
      setIsStaff(staffStatus)
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

  const navItems = isStaff ? STAFF_NAV_ITEMS : CLIENT_NAV_ITEMS

  // Mobile drawer hides items that already live in the client bottom nav
  const MOBILE_BOTTOM_NAV = new Set(['Coach Katie', 'Messages', 'Community'])
  const mobileNavItems = isStaff ? navItems : navItems.filter(i => !MOBILE_BOTTOM_NAV.has(i.label))

  function buildSidebarContent(items) { return (
    <>
      {/* Logo */}
      <div className="mx-4 mt-5 mb-4">
        <div className="bg-white rounded-xl overflow-hidden px-3 py-2.5">
          <img
            src="/logo.png"
            alt="Life Warrior Coaching"
            className="w-full h-11 object-contain"
          />
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 space-y-0.5">
        {items.map(({ to, href, label }) =>
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
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-[#E8670A] text-white'
                    : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`
              }
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
              {label === 'Messages' && msgUnread > 0 && (
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
          onClick={() => signOut(() => navigate('/sign-in'))}
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
            {buildSidebarContent(mobileNavItems)}
          </aside>
        </div>
      )}

      <main className="flex-1 overflow-y-auto p-4 lg:p-8 pb-[calc(5.75rem+env(safe-area-inset-bottom))] lg:pb-8">
        {/* Mobile hamburger */}
        <button
          className="lg:hidden mb-4 p-2 rounded-lg text-gray-500 hover:bg-gray-200 transition-colors"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open menu"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <Outlet />
      </main>

      {/* Mobile bottom nav */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200 flex pb-[env(safe-area-inset-bottom)]">
        {(isStaff ? [
          // Staff bottom nav
          { to: '/dashboard',     label: 'Coaching',  badge: false,          icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" /> },
          { to: '/admin/clients', label: 'Clients',   badge: false,          icon: <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
          { to: '/messages',      label: 'Messages',  badge: msgUnread > 0,  icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /> },
          { to: '/community',     label: 'Community', badge: notifCount > 0, icon: <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
        ] : [
          // Client bottom nav
          { to: '/dashboard', label: 'Home',      badge: false,           icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /> },
          { to: '/ai-coach',  label: 'Katie',     badge: katieUnread > 0, icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /> },
          { to: '/messages',  label: 'Messages',  badge: msgUnread > 0,   icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /> },
          { to: '/community', label: 'Community', badge: notifCount > 0,  icon: <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
        ]).reduce((acc, { to, label, icon, badge }, i) => {
          // Inject the plus button in the middle (after Home)
          if (i === 1 && !isStaff) acc.push(
            <button
              key="quick-log"
              onClick={openQuickMenu}
              className="flex-1 flex flex-col items-center justify-center py-2 gap-0.5 min-w-0"
            >
              <div className="w-11 h-11 rounded-full bg-[#E8670A] flex items-center justify-center shadow-md -mt-5">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              </div>
              <span className="text-xs font-medium text-gray-400">Log</span>
            </button>
          )
          acc.push(
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
          )
          return acc
        }, [])}
      </nav>
      {/* Quick-log bottom sheet */}
      {quickMenuOpen && (
        <>
          <div className="fixed inset-0 z-50 bg-black/40" onClick={closeQuickMenu} />
          <div className="fixed bottom-0 left-0 right-0 z-50 bg-white rounded-t-2xl shadow-2xl max-h-[calc(100vh-1rem)] overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            {/* drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>
            {/* header */}
            <div className="flex items-center justify-between px-5 py-3">
              {quickAction ? (
                <button
                  onClick={() => { setQuickAction(null); setQuickValue(''); setQuickDone(false); resetQuickExtras() }}
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
              <button onClick={closeQuickMenu} className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 text-lg leading-none">
                ×
              </button>
            </div>

            {/* tile grid */}
            {!quickAction && (
              <div className="px-4 pb-10 pt-1 grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { id: 'food',     emoji: '🍽️', label: 'Log Food' },
                  { id: 'water',    emoji: '💧', label: 'Water' },
                  { id: 'weight',   emoji: '⚖️', label: 'Weight' },
                  { id: 'steps',    emoji: '👟', label: 'Steps' },
                  { id: 'sleep',    emoji: '😴', label: 'Sleep' },
                  { id: 'activity', emoji: '🏃', label: 'Activity' },
                ].map(({ id, emoji, label }) => (
                  <button
                    key={id}
                    onClick={() => {
                      if (id === 'food') { closeQuickMenu(); navigate('/journal') }
                      else setQuickAction(id)
                    }}
                    className="flex flex-col items-center justify-center gap-2 bg-gray-50 hover:bg-[#fde8c8] active:bg-[#fcd9b0] rounded-2xl py-4 px-2 transition-colors min-h-[84px]"
                  >
                    <span className="text-2xl leading-none">{emoji}</span>
                    <span className="text-xs font-semibold text-gray-700 text-center leading-tight">{label}</span>
                  </button>
                ))}
              </div>
            )}

            {/* success state */}
            {quickAction && quickDone && (
              <div className="px-5 pb-12 pt-4 text-center">
                <p className="text-3xl mb-2">✅</p>
                <p className="text-sm font-semibold text-gray-700">Logged!</p>
              </div>
            )}

            {/* mini-form */}
            {quickAction && !quickDone && (
              <div className="px-5 pb-10 pt-2">
                {/* water */}
                {quickAction === 'water' && (
                  <>
                    <p className="text-sm text-gray-500 mb-3">How many oz to add today?</p>
                    <div className="flex gap-2 mb-3">
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
                          {oz} oz
                        </button>
                      ))}
                    </div>
                    <input
                      type="number"
                      value={quickValue}
                      onChange={e => setQuickValue(e.target.value)}
                      placeholder="Custom amount (oz)"
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-[#E8670A] mb-4"
                    />
                    <button onClick={submitQuickLog} disabled={!quickValue || quickSaving}
                      className="w-full bg-[#E8670A] text-white font-bold py-3.5 rounded-2xl text-sm hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                      {quickSaving ? 'Saving…' : 'Log Water'}
                    </button>
                  </>
                )}

                {/* weight */}
                {quickAction === 'weight' && (
                  <>
                    <p className="text-sm text-gray-500 mb-3">Today's weight (lbs)</p>
                    <input type="number" step="0.1" value={quickValue}
                      onChange={e => setQuickValue(e.target.value)}
                      placeholder="e.g. 145.5" autoFocus
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
                    <p className="text-sm text-gray-500 mb-3">Today's steps</p>
                    <input type="number" value={quickValue}
                      onChange={e => setQuickValue(e.target.value)}
                      placeholder="e.g. 8500" autoFocus
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-[#E8670A] mb-4"
                    />
                    <button onClick={submitQuickLog} disabled={!quickValue || quickSaving}
                      className="w-full bg-[#E8670A] text-white font-bold py-3.5 rounded-2xl text-sm hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                      {quickSaving ? 'Saving…' : 'Log Steps'}
                    </button>
                  </>
                )}

                {/* sleep */}
                {quickAction === 'sleep' && (
                  <>
                    <p className="text-sm text-gray-500 mb-3">Hours slept last night</p>
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
                      placeholder="Custom hours (e.g. 7.5)" autoFocus
                      className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-[#E8670A] mb-4"
                    />
                    <button onClick={submitQuickLog} disabled={!quickValue || quickSaving}
                      className="w-full bg-[#E8670A] text-white font-bold py-3.5 rounded-2xl text-sm hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                      {quickSaving ? 'Saving…' : 'Log Sleep'}
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
                        <img src={quickPhotoPreview} alt="Preview" className="w-full max-h-44 object-cover rounded-xl" />
                        <button
                          onClick={() => { URL.revokeObjectURL(quickPhotoPreview); setQuickPhotoPreview(null); setQuickPhotoFile(null) }}
                          className="absolute top-2 right-2 w-7 h-7 bg-white rounded-full flex items-center justify-center shadow text-gray-600 font-bold"
                        >×</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => quickPhotoInputRef.current?.click()}
                        className="w-full border-2 border-dashed border-gray-300 rounded-xl py-7 text-sm text-gray-400 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors mb-4"
                      >
                        📷 Tap to select photo
                      </button>
                    )}
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
