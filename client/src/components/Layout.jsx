import { useState, useEffect, useCallback } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { UserButton, useUser, useAuth, useClerk } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

const NAV_ITEMS = [
  { to: '/dashboard',    label: 'Dashboard' },
  { to: '/ai-coach',     label: 'Coach Katie' },
  { href: 'https://www.lwcvip.com/mindset', label: 'Brain Mapping' },
  { to: '/journal',      label: 'Log Food' },
  { to: '/calendar',     label: 'Habit Calendar' },
  { to: '/food-list',    label: 'Food List' },
  { to: '/workouts',     label: 'Workouts' },
  { to: '/badges',       label: 'Achievements' },
  { to: '/community',    label: 'Community' },
  { to: '/settings',     label: 'Settings' },
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
  const [sidebarOpen,  setSidebarOpen]  = useState(false)

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

  const navItems = isAdmin
    ? [...NAV_ITEMS, { to: '/admin/clients', label: 'Clients' }, { to: '/admin', label: 'Admin' }]
    : isStaff
    ? [...NAV_ITEMS, { to: '/admin/clients', label: 'Clients' }]
    : NAV_ITEMS

  const sidebarContent = (
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
        {navItems.map(({ to, href, label }) =>
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
            </NavLink>
          )
        )}
      </nav>

      {/* Support */}
      <div className="px-4 pt-2 pb-1" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
        <a
          href="mailto:info@lwcvip.com"
          className="flex items-center px-3 py-2 rounded-lg text-xs text-white/50 hover:bg-white/10 hover:text-white/80 transition-colors"
        >
          Support — info@lwcvip.com
        </a>
      </div>

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
  )

  return (
    <div className="flex h-screen bg-gray-50">

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-60 flex-shrink-0 flex-col" style={{ backgroundColor: SIDEBAR_BG }}>
        {sidebarContent}
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="relative z-50 w-60 flex flex-col flex-shrink-0" style={{ backgroundColor: SIDEBAR_BG }}>
            {sidebarContent}
          </aside>
        </div>
      )}

      <main className="flex-1 overflow-y-auto p-4 lg:p-8 pb-20 lg:pb-8">
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
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200 flex">
        {[
          { to: '/dashboard', label: 'Home',      badge: katieUnread > 0, icon: <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /> },
          { to: '/journal',   label: 'Log',       badge: false, icon: <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /> },
          { to: '/ai-coach',  label: 'Katie',     badge: katieUnread > 0, icon: <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /> },
          { to: '/community', label: 'Community', badge: notifCount > 0,  icon: <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
          { to: '/settings',  label: 'Settings',  badge: false, icon: <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />, extraPath: <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /> },
        ].map(({ to, label, icon, extraPath, badge }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-xs font-medium transition-colors ${
                isActive ? 'text-[#E8670A]' : 'text-gray-400'
              }`
            }
          >
            <div className="relative">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                {icon}
                {extraPath}
              </svg>
              {badge && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-[#E8670A] rounded-full" />
              )}
            </div>
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
