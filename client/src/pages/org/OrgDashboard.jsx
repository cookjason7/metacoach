// OrgDashboard.jsx — landing page for gym owners / org-level admins.
// Rendered at /org/dashboard, gated by OrgAdminRoute in App.jsx.
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, useUser } from '@clerk/clerk-react'
import { API_URL } from '../../config.js'

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

// Mirrors the checklist shown in the Setup Progress card — order matters for display.
function setupSteps(org, aiConfig, hasClients) {
  return [
    { label: 'Organization name set',        done: Boolean(org?.name?.trim()) },
    { label: 'Logo uploaded',                done: Boolean(org?.logo_url?.trim()) },
    { label: 'AI coach name customized',      done: Boolean(aiConfig?.coach_name?.trim()) && aiConfig.coach_name !== 'Katie' },
    { label: 'Coaching philosophy added',     done: Boolean(aiConfig?.coaching_philosophy?.trim()) },
    { label: 'First client invited',          done: Boolean(hasClients) },
  ]
}

function StatCard({ label, value }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-col gap-0.5">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-2xl font-bold text-gray-900">{value ?? '—'}</span>
    </div>
  )
}

function QuickActionButton({ to, label, icon }) {
  return (
    <Link
      to={to}
      className="min-h-11 flex-1 min-w-[140px] flex items-center justify-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-2.5 text-sm font-semibold text-gray-700 hover:border-orange-200 hover:bg-orange-50 hover:text-[#E8670A] transition-colors"
    >
      <span className="text-base leading-none">{icon}</span>
      {label}
    </Link>
  )
}

export default function OrgDashboard() {
  const { getToken } = useAuth()
  const { user } = useUser()

  const [org,          setOrg]          = useState(null)
  const [aiConfig,     setAiConfig]     = useState(null)
  const [stats,        setStats]        = useState(null)
  const [recentClients, setRecentClients] = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const headers = { Authorization: `Bearer ${token}` }
      const [orgRes, aiRes, statsRes, recentRes] = await Promise.all([
        fetch(`${API_URL}/api/organizations/mine`,               { headers }),
        fetch(`${API_URL}/api/organizations/mine/ai-config`,     { headers }),
        fetch(`${API_URL}/api/organizations/mine/dashboard`,     { headers }),
        fetch(`${API_URL}/api/organizations/mine/recent-clients`, { headers }),
      ])
      if (!orgRes.ok || !statsRes.ok) throw new Error('Failed to load your organization')
      setOrg(await orgRes.json())
      setAiConfig(aiRes.ok ? await aiRes.json() : null)
      setStats(await statsRes.json())
      setRecentClients(recentRes.ok ? await recentRes.json() : [])
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [getToken])

  useEffect(() => { load() }, [load])

  if (loading) return <p className="text-sm text-gray-400 text-center py-12">Loading your dashboard…</p>
  if (error)   return <p className="text-sm text-red-500 py-4">{error}</p>

  const steps = setupSteps(org, aiConfig, Number(stats?.total_clients) > 0)
  const setupComplete = steps.every(s => s.done)
  const firstName = user?.firstName ?? user?.fullName ?? 'there'

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Welcome back, {firstName}</h1>
        <p className="text-sm text-gray-500 mt-0.5">{org?.name}</p>
      </div>

      {/* Setup banner */}
      {!setupComplete && (
        <Link
          to="/org/setup"
          className="block mb-6 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 hover:bg-amber-100 transition-colors"
        >
          <p className="text-sm font-semibold text-amber-800">
            Finish setting up your organization →
          </p>
        </Link>
      )}

      {/* Stats bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total Clients"              value={stats?.total_clients} />
        <StatCard label="Active This Week"            value={stats?.active_clients} />
        <StatCard label="Messages This Week"          value={stats?.messages_this_week} />
        <StatCard label="Habits Completed This Week"  value={stats?.habits_completed_this_week} />
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-3 mb-6">
        <QuickActionButton to="/admin/clients" label="Add Client"    icon="＋" />
        <QuickActionButton to="/messages"      label="Send Message"  icon="✉️" />
        <QuickActionButton to="/calendar"      label="View Calendar" icon="📅" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Recent Activity */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-900">Recent Activity</p>
          </div>
          {recentClients.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-8">No client logins yet.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {recentClients.map(c => (
                <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
                  <p className="text-xs text-gray-400 shrink-0">{fmtDateTime(c.last_login_at)}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Setup Progress */}
        {!setupComplete && (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-900">Setup Progress</p>
              <Link to="/org/setup" className="text-xs font-semibold text-[#E8670A] hover:text-[#c45e09]">
                Go to setup →
              </Link>
            </div>
            <ul className="divide-y divide-gray-100">
              {steps.map(step => (
                <li key={step.label} className="flex items-center gap-3 px-4 py-2.5">
                  <span className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold ${
                    step.done ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-400'
                  }`}>
                    {step.done ? '✓' : ''}
                  </span>
                  <span className={`text-sm ${step.done ? 'text-gray-500 line-through' : 'text-gray-800'}`}>
                    {step.label}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
