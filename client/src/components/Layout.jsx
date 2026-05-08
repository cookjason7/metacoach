import { useState, useEffect, useCallback } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { UserButton, useUser, useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

const NAV_ITEMS = [
  { to: '/dashboard',    label: 'Dashboard' },
  { to: '/ai-coach',     label: 'Coach Katie' },
  { href: 'https://www.lwcvip.com/mindset', label: 'Brain Mapping' },
  { to: '/journal',      label: 'Log Food' },
  { to: '/food-list',    label: 'Food List' },
  { to: '/workouts',     label: 'Workouts' },
  { to: '/community',    label: 'Community' },
  { to: '/settings',     label: 'Settings' },
]

const SIDEBAR_BG = '#0F1E35'

export default function Layout() {
  const { user, isLoaded } = useUser()
  const { getToken }       = useAuth()
  const [isAdmin,     setIsAdmin]     = useState(false)
  const [notifCount,  setNotifCount]  = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(false)

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
      console.log('[layout] role:', data.role)
      setIsAdmin(data.role === 'admin')
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

  useEffect(() => {
    fetchRole()
  }, [fetchRole])

  useEffect(() => {
    fetchNotifCount()
    const id = setInterval(fetchNotifCount, 60_000)
    return () => clearInterval(id)
  }, [fetchNotifCount])

  const navItems = isAdmin
    ? [...NAV_ITEMS, { to: '/admin', label: 'Admin' }]
    : NAV_ITEMS

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="mx-4 mt-5 mb-4">
        <div className="bg-white rounded-xl overflow-hidden px-3 py-2.5">
          <img
            src="/lwc-logo.png"
            alt="Life Warrior Coaching"
            className="w-full h-11 object-contain"
          />
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-0.5">
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
      <div className="px-4 py-4 flex items-center gap-3" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
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

      <main className="flex-1 overflow-y-auto p-4 lg:p-8">
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
    </div>
  )
}
