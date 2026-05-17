import { useEffect, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { Link } from 'react-router-dom'
import { API_URL } from '../config.js'
import MicronutrientTotals, { calculateMicronutrientTotals } from '../components/MicronutrientTotals.jsx'

// ── Gamification Banner (compact, tappable) ───────────────────────────────────

const STREAK_ITEMS = [
  { icon: '🔥', key: 'food_log' },
  { icon: '💧', key: 'water_goal' },
  { icon: '💪', key: 'protein_goal' },
  { icon: '🏋️', key: 'workout' },
]

function GamificationCard({ data, loading }) {
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3 mb-5 animate-pulse">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-6 h-6 bg-gray-100 rounded" />
          <div className="h-3.5 bg-gray-100 rounded w-20" />
          <div className="ml-auto flex gap-3">
            {[...Array(4)].map((_, i) => <div key={i} className="w-8 h-3.5 bg-gray-100 rounded" />)}
          </div>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full" />
      </div>
    )
  }
  if (!data) return null

  return (
    <Link
      to="/badges"
      className="block bg-white rounded-2xl border border-gray-200 px-4 py-3 mb-5 hover:border-gray-300 active:bg-gray-50 transition-colors group"
    >
      {/* Row 1 — rank icon · rank name · XP · streaks · chevron */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg leading-none shrink-0">{data.rank_icon}</span>
        <span className="text-sm font-bold leading-none shrink-0" style={{ color: data.rank_color }}>
          {data.rank}
        </span>
        <span className="text-xs text-gray-400 leading-none shrink-0">
          {data.total_xp.toLocaleString()} XP
        </span>

        {/* Streaks pushed to the right */}
        <div className="ml-auto flex items-center gap-3">
          {STREAK_ITEMS.map(s => {
            const count = data.streaks[s.key] ?? 0
            const hot   = count >= 3
            return (
              <span key={s.key}
                className={`text-xs font-bold leading-none tabular-nums ${hot ? 'text-[#E8670A]' : 'text-gray-400'}`}>
                {s.icon} {count}
              </span>
            )
          })}
          <svg className="w-3.5 h-3.5 text-gray-300 group-hover:text-gray-500 transition-colors shrink-0"
            fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </div>

      {/* Row 2 — XP progress bar */}
      <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${data.next_rank ? data.progress_pct : 100}%`,
            backgroundColor: data.rank_color,
          }}
        />
      </div>
      {data.next_rank && (
        <p className="text-[10px] text-gray-400 mt-0.5 text-right leading-none">
          {data.xp_to_next_rank} XP to {data.next_rank}
        </p>
      )}
    </Link>
  )
}

function KatieBanner({ message, onDismiss }) {
  if (!message) return null
  return (
    <Link
      to="/ai-coach"
      className="flex items-start gap-3 bg-[#fff7ed] border border-[#fed7aa] rounded-xl px-4 py-3 mb-6 group hover:bg-[#ffedd5] transition-colors"
      onClick={onDismiss}
    >
      <div className="w-8 h-8 rounded-full bg-[#fde8c8] flex items-center justify-center text-[#E8670A] font-bold text-xs shrink-0 mt-0.5">
        K
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-[#E8670A] mb-0.5">New message from Coach Katie</p>
        <p className="text-sm text-gray-700 line-clamp-2">{message}</p>
      </div>
      <svg className="w-4 h-4 text-[#E8670A] shrink-0 mt-1 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </Link>
  )
}

function StatCard({ label, value, sub, color = 'text-gray-900' }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function TrackerCard({ label, unit, field, currentValue, onSave }) {
  const [editing, setEditing] = useState(false)
  const [input,   setInput]   = useState('')
  const [saving,  setSaving]  = useState(false)

  function openEdit() {
    setInput(currentValue != null ? String(currentValue) : '')
    setEditing(true)
  }

  function cancel() { setEditing(false) }

  async function handleSave() {
    const num = parseFloat(input)
    if (isNaN(num) || num < 0) return
    setSaving(true)
    try {
      await onSave(field, num)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="bg-white rounded-xl border border-gray-200 p-3 flex flex-col items-center text-center cursor-pointer select-none"
      onClick={!editing ? openEdit : undefined}
    >
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      {editing ? (
        <div className="w-full" onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            type="number"
            min="0"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') cancel() }}
            className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-[#E8670A] mb-2"
          />
          <div className="flex gap-1.5 justify-center">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 bg-[#E8670A] text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-60"
            >
              {saving ? '…' : '✓'}
            </button>
            <button
              onClick={cancel}
              className="flex-1 bg-gray-100 text-gray-600 text-xs font-medium py-1.5 rounded-lg"
            >
              ✕
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-2xl font-bold text-gray-900 leading-none">
            {currentValue != null ? currentValue : <span className="text-gray-300">—</span>}
          </p>
          <p className="text-xs text-gray-400 mt-1">{unit}</p>
        </>
      )}
    </div>
  )
}

// ── Women's Health ────────────────────────────────────────────────────────────

function FoundationRing({ label, value, goal, color, unit }) {
  const r = 27
  const circ = 2 * Math.PI * r
  const pct    = goal > 0 ? Math.min(value / goal, 1) : 0
  const offset = circ * (1 - pct)
  const over   = goal > 0 && value > goal
  const fmtVal = unit === 'mcg' ? Number(value).toFixed(1).replace(/\.0$/, '') : Math.round(value)
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-[62px] h-[62px]">
        <svg className="w-full h-full" viewBox="0 0 62 62" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="31" cy="31" r={r} fill="none" stroke="#f3f4f6" strokeWidth="6" />
          <circle cx="31" cy="31" r={r} fill="none"
            stroke={over ? '#ef4444' : color}
            strokeWidth="6" strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.5s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-px">
          <span className="text-[11px] font-bold text-gray-900 leading-none">{fmtVal}</span>
          {unit && <span className="text-[8px] text-gray-400 leading-none">{unit}</span>}
        </div>
      </div>
      <span className="text-[10px] font-semibold text-gray-600 text-center leading-tight">{label}</span>
      <span className="text-[9px] text-gray-400 leading-none">/ {goal}{unit}</span>
    </div>
  )
}

function WomensHealthFoundation({ meals, waterOz, onAddWater }) {
  const [addingWater, setAddingWater] = useState(false)
  const [oz, setOz] = useState('8')
  const micros = calculateMicronutrientTotals(meals)
  const getMicro = (key) => micros.find(m => m.key === key)?.value ?? 0

  function handleAddWater() {
    const amount = parseFloat(oz)
    if (!isNaN(amount) && amount > 0) { onAddWater(amount); setAddingWater(false); setOz('8') }
  }

  const rings = [
    { label: 'Water',     value: waterOz ?? 0,             goal: 64,   unit: 'oz',  color: '#60A5FA' },
    { label: 'Calcium',   value: getMicro('calcium_mg'),    goal: 1200, unit: 'mg',  color: '#3B82F6' },
    { label: 'Vitamin D', value: getMicro('vitamin_d_mcg'), goal: 20,   unit: 'mcg', color: '#F59E0B' },
    { label: 'Iron',      value: getMicro('iron_mg'),       goal: 18,   unit: 'mg',  color: '#8B5CF6' },
  ]
  const overallPct = rings.reduce((s, r) => s + Math.min(r.goal > 0 ? r.value / r.goal : 0, 1), 0) / rings.length
  const statusLabel = p => p >= 0.8 ? 'On track' : p >= 0.5 ? 'Strong start' : p >= 0.2 ? 'Needs attention' : 'Low today'

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Women's Health</h2>
          <p className="text-[11px] text-gray-400 mt-0.5">{statusLabel(overallPct)}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold" style={{ color: '#3B82F6' }}>{Math.round(overallPct * 100)}%</p>
          <p className="text-[10px] text-gray-400">complete</p>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-y-4 gap-x-2 mb-3">
        {rings.map(r => <FoundationRing key={r.label} {...r} />)}
      </div>
      <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
        <span className="text-[11px] text-gray-400">Log water</span>
        {!addingWater ? (
          <button
            onClick={() => setAddingWater(true)}
            className="w-5 h-5 bg-blue-100 text-blue-600 rounded-full text-xs font-bold flex items-center justify-center hover:bg-blue-200 transition-colors"
          >+</button>
        ) : (
          <span className="flex items-center gap-1">
            <input type="number" value={oz} onChange={e => setOz(e.target.value)}
              className="w-12 border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
              min="1" />
            <span className="text-xs text-gray-400">oz</span>
            <button onClick={handleAddWater} className="text-xs text-blue-600 font-semibold hover:text-blue-800">Add</button>
            <button onClick={() => setAddingWater(false)} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
          </span>
        )}
      </div>
    </div>
  )
}

// ── Coaching Dashboard (shown to coaches and admins) ─────────────────────────

function CoachStatCard({ label, value, sub, accent = false, href }) {
  const inner = (
    <div className={`bg-white rounded-xl border p-4 ${accent ? 'border-[#E8670A]' : 'border-gray-200'}`}>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent ? 'text-[#E8670A]' : 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
  return href ? <Link to={href} className="block hover:opacity-90 transition-opacity">{inner}</Link> : inner
}

function CoachDashboard({ getToken }) {
  const [clients,      setClients]      = useState([])
  const [msgUnread,    setMsgUnread]    = useState(0)
  const [checkins,     setCheckins]     = useState([])
  const [activity,     setActivity]     = useState([])
  const [loading,      setLoading]      = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token   = await getToken()
        const headers = { Authorization: `Bearer ${token}` }
        const [r1, r2, r3] = await Promise.all([
          fetch(`${API_URL}/api/coach-admin/clients?status=active`, { headers }),
          fetch(`${API_URL}/api/messages/unread-count`,             { headers }),
          fetch(`${API_URL}/api/coach-admin/dashboard-summary`,      { headers }),
        ])
        if (!cancelled) {
          if (r1.ok) setClients(await r1.json())
          if (r2.ok) { const d = await r2.json(); setMsgUnread(d.unread ?? 0) }
          if (r3.ok) {
            const d = await r3.json()
            setCheckins(d.checkins ?? [])
            setActivity(d.activity ?? [])
          }
        }
      } catch {} finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [getToken])

  function daysSince(iso) {
    if (!iso) return null
    return Math.floor((Date.now() - new Date(iso)) / 86400_000)
  }

  function fmtShortDate(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  function fmtDateTime(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  const needsAttention = clients.filter(c => c.status_tag === 'Needs Attention')
  const noRecentLogs   = clients.filter(c => {
    const d = daysSince(c.last_meal_at)
    return d === null || d > 3
  })

  const adherenceColor = v => {
    const n = Number(v) || 0
    if (n >= 80) return 'text-emerald-600'
    if (n >= 50) return 'text-blue-600'
    if (n >= 30) return 'text-amber-600'
    return 'text-gray-400'
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Coaching Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">What needs your attention today.</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <CoachStatCard
          label="Active Clients"
          value={loading ? '…' : clients.length}
          sub="in your roster"
          href="/admin/clients"
        />
        <CoachStatCard
          label="Needs Attention"
          value={loading ? '…' : needsAttention.length}
          sub="by status tag"
          accent={!loading && needsAttention.length > 0}
          href="/admin/clients"
        />
        <CoachStatCard
          label="Unread Messages"
          value={loading ? '…' : msgUnread}
          sub="from clients"
          accent={!loading && msgUnread > 0}
          href="/messages"
        />
        <CoachStatCard
          label="No Recent Logs"
          value={loading ? '…' : noRecentLogs.length}
          sub="3+ days inactive"
          accent={!loading && noRecentLogs.length > 0}
          href="/admin/clients"
        />
      </div>

      {/* Clients needing attention */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold text-gray-700">Clients Needing Attention</p>
          <Link to="/admin/clients" className="text-xs text-[#E8670A] hover:text-[#c45e09] font-medium">View all →</Link>
        </div>
        {loading ? (
          <p className="text-sm text-gray-400 py-6 text-center">Loading…</p>
        ) : needsAttention.length === 0 ? (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-4 text-center">
            <p className="text-sm text-green-700 font-medium">No clients need review right now.</p>
            <p className="text-xs text-green-600 mt-0.5">All clients are on track.</p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {needsAttention.slice(0, 5).map(c => {
              const inactive = daysSince(c.last_meal_at ?? c.last_login_at)
              return (
                <Link key={c.id} to={`/admin/clients/${c.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-orange-50/50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">
                      {[c.first_name, c.display_last_name].filter(Boolean).join(' ') || c.email || 'Unknown'}
                    </p>
                    <p className="text-xs text-gray-400">
                      {c.last_meal_at
                        ? `Last log: ${fmtShortDate(c.last_meal_at)}`
                        : inactive === 0 ? 'Active today' : inactive === null ? 'No meals logged' : `Last log: ${inactive}d ago`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`text-xs font-bold ${adherenceColor(c.adherence_7d)}`}>
                      {Math.round(Number(c.adherence_7d) || 0)}% 7d
                    </span>
                    <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </Link>
              )
            })}
            {needsAttention.length > 5 && (
              <div className="px-4 py-2 text-xs text-gray-400 text-center">
                +{needsAttention.length - 5} more — <Link to="/admin/clients" className="text-[#E8670A]">view all</Link>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Inactive clients */}
      <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-gray-700">No Recent Logs (3+ days)</p>
            <Link to="/admin/clients" className="text-xs text-[#E8670A] hover:text-[#c45e09] font-medium">View all →</Link>
          </div>
          {loading ? (
            <p className="text-sm text-gray-400 py-6 text-center">Loading...</p>
          ) : noRecentLogs.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-5 text-center">
              <p className="text-sm text-gray-500">Everyone has logged recently.</p>
            </div>
          ) : (
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {noRecentLogs.slice(0, 4).map(c => {
              return (
                <Link key={c.id} to={`/admin/clients/${c.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-orange-50/50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">
                      {[c.first_name, c.display_last_name].filter(Boolean).join(' ') || c.email || 'Unknown'}
                    </p>
                  </div>
                  <p className="text-xs text-gray-400 shrink-0">
                    {c.last_meal_at ? `Last logged ${fmtShortDate(c.last_meal_at)}` : 'Never logged'}
                  </p>
                </Link>
              )
            })}
          </div>
          )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-gray-700">Check-ins Needing Review</p>
            <Link to="/admin/forms" className="text-xs text-[#E8670A] hover:text-[#c45e09] font-medium">Forms →</Link>
          </div>
          {loading ? (
            <p className="text-sm text-gray-400 py-6 text-center">Loading...</p>
          ) : checkins.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-5 text-center">
              <p className="text-sm text-gray-500">No check-ins need review right now.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100 overflow-hidden">
              {checkins.map(item => (
                <Link
                  key={item.submission_id}
                  to={`/admin/clients/${item.client_id}?tab=assessment`}
                  className="block px-4 py-3 hover:bg-orange-50/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{item.client_name}</p>
                      <p className="text-xs text-gray-500 truncate">{item.form_title}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        Submitted {fmtDateTime(item.submitted_at)}
                        {item.due_at ? ` · Due ${fmtShortDate(item.due_at)}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                      {item.status}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-gray-700">Recent Client Activity</p>
            <Link to="/admin/clients" className="text-xs text-[#E8670A] hover:text-[#c45e09] font-medium">View all →</Link>
          </div>
          {loading ? (
            <p className="text-sm text-gray-400 py-6 text-center">Loading...</p>
          ) : activity.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-5 text-center">
              <p className="text-sm text-gray-500">No recent client activity to show yet.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100 overflow-hidden">
              {activity.map((event, idx) => (
                <Link
                  key={`${event.type}-${event.client_id}-${event.occurred_at}-${idx}`}
                  to={`/admin/clients/${event.client_id}`}
                  className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-orange-50/50 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{event.client_name}</p>
                    <p className="text-xs text-gray-500 truncate">{event.label}</p>
                  </div>
                  <p className="text-[11px] text-gray-400 shrink-0">{fmtShortDate(event.occurred_at)}</p>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quick links */}
      <div className="flex flex-wrap gap-2 pt-1">
        <Link to="/admin/clients"
          className="inline-flex items-center gap-1.5 bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors">
          View All Clients
        </Link>
        <Link to="/messages"
          className="inline-flex items-center gap-1.5 bg-white border border-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors">
          Open Inbox {msgUnread > 0 && <span className="bg-[#E8670A] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{msgUnread}</span>}
        </Link>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { getToken } = useAuth()

  const [todayMeals,   setTodayMeals]   = useState(null)
  const [mealRows,     setMealRows]     = useState([])
  const [todayLog,     setTodayLog]     = useState(null)
  const [weekMeals,    setWeekMeals]    = useState(null)
  const [weekLog,      setWeekLog]      = useState(null)
  const [userProfile,  setUserProfile]  = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [katieBanner,  setKatieBanner]  = useState(null)
  const [gamData,      setGamData]      = useState(null)
  const [gamLoading,   setGamLoading]   = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token   = await getToken()
        const headers = { Authorization: `Bearer ${token}` }
        const today   = new Date().toLocaleDateString('sv')

        // Fire proactive check non-blocking, then fetch latest banner
        fetch(`${API_URL}/api/coach/check-proactive`, { method: 'POST', headers }).catch(() => {})

        const [r1, r2, r3, r4, r5, r6, r7, r8] = await Promise.all([
          fetch(`${API_URL}/api/meals/today?date=${today}`, { headers }),
          fetch(`${API_URL}/api/daily-logs/today`, { headers }),
          fetch(`${API_URL}/api/meals/week`,       { headers }),
          fetch(`${API_URL}/api/daily-logs/week`,  { headers }),
          fetch(`${API_URL}/api/users/me`,         { headers }),
          fetch(`${API_URL}/api/meals?date=${today}`, { headers }),
          fetch(`${API_URL}/api/coach/latest-proactive`, { headers }),
          fetch(`${API_URL}/api/gamification/me`,  { headers }),
        ])

        if (!r1.ok || !r2.ok || !r3.ok || !r4.ok || !r5.ok || !r6.ok) throw new Error('Failed to load dashboard data')

        if (!cancelled) {
          const [m, l, wm, wl, u, rows] = await Promise.all([r1.json(), r2.json(), r3.json(), r4.json(), r5.json(), r6.json()])
          setTodayMeals(m)
          setMealRows(rows)
          setTodayLog(l)
          setWeekMeals(wm)
          setWeekLog(wl)
          setUserProfile(u)
          if (r7.ok) {
            const bannerData = await r7.json()
            setKatieBanner(bannerData.message ?? null)
          }
          if (r8.ok) setGamData(await r8.json())
          setGamLoading(false)
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) { setLoading(false); setGamLoading(false) }
      }
    }
    load()
    return () => { cancelled = true }
  }, [getToken])

  async function saveTracker(field, value) {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/daily-logs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    })
    if (!res.ok) throw new Error('Failed to save')
    setTodayLog(await res.json())
  }

  const fmt   = (n) => n != null ? n.toLocaleString() : '—'
  const fmtG  = (n) => n != null ? `${n}g` : '—'
  const fmtLb = (n) => n != null ? `${n} lbs` : '—'

  const todayStats = [
    { label: 'Calories',  value: fmt(todayMeals?.total_calories), color: 'text-orange-500' },
    { label: 'Protein',   value: fmtG(todayMeals?.total_protein), color: 'text-blue-600' },
    { label: 'Carbs',     value: fmtG(todayMeals?.total_carbs),   color: 'text-yellow-500' },
    { label: 'Fat',       value: fmtG(todayMeals?.total_fat),     color: 'text-pink-500' },
    { label: 'Fiber',     value: fmtG(todayMeals?.total_fiber),   color: 'text-[#E8670A]' },
    { label: 'Water',     value: todayLog?.water_oz != null ? `${todayLog.water_oz} oz` : '—', color: 'text-cyan-500' },
    { label: 'Steps',     value: fmt(todayLog?.steps),            color: 'text-purple-500' },
  ]

  const weekStats = [
    { label: 'Avg Cal / day',     value: fmt(weekMeals?.avg_calories),                   color: 'text-orange-500' },
    { label: 'Avg Protein / day', value: fmtG(weekMeals?.avg_protein),                   color: 'text-blue-600' },
    { label: 'Avg Carbs / day',   value: fmtG(weekMeals?.avg_carbs),                     color: 'text-yellow-500' },
    { label: 'Avg Fat / day',     value: fmtG(weekMeals?.avg_fat),                       color: 'text-pink-500' },
    { label: 'Meals this week',   value: fmt(weekMeals?.meals_this_week),                color: 'text-[#E8670A]' },
    { label: 'Avg Water / day',   value: weekLog?.avg_water_oz != null ? `${weekLog.avg_water_oz} oz` : '—', color: 'text-cyan-500' },
    { label: 'Avg Steps / day',   value: fmt(weekLog?.avg_steps),                        color: 'text-purple-500' },
    { label: 'Avg Weight',        value: fmtLb(weekLog?.avg_weight),                     color: 'text-gray-700' },
  ]

  const trackers = [
    { label: 'Water',  unit: 'oz',    field: 'water_oz',   currentValue: todayLog?.water_oz },
    { label: 'Steps',  unit: 'steps', field: 'steps',      currentValue: todayLog?.steps },
    { label: 'Weight', unit: 'lbs',   field: 'weight_lbs', currentValue: todayLog?.weight_lbs },
  ]

  // Staff (admin/coach) see the coaching dashboard instead
  if (!loading && (userProfile?.role === 'admin' || userProfile?.role === 'coach')) {
    return <CoachDashboard getToken={getToken} />
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Dashboard</h1>
      <p className="text-sm text-gray-500 mb-4">Today's overview</p>

      {/* Gamification — compact rank/XP/streak bar */}
      <GamificationCard data={gamData} loading={gamLoading} />

      <KatieBanner message={katieBanner} onDismiss={() => setKatieBanner(null)} />

      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          Could not load data: {error}
        </div>
      )}

      {/* Daily Totals */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Today's Totals</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {todayStats.map((s) => (
          <StatCard key={s.label} label={s.label} value={loading ? '…' : s.value} color={s.color} />
        ))}
      </div>

      <div className="mb-8">
        <MicronutrientTotals meals={mealRows} loading={loading} title="Today's Micronutrients" periodLabel="Today" exclude={['fiber_g']} />
      </div>

      <WomensHealthFoundation
        meals={mealRows}
        waterOz={todayLog?.water_oz}
        onAddWater={async (v) => { await saveTracker('water_oz', (todayLog?.water_oz ?? 0) + v) }}
      />

      {!loading && todayMeals?.meal_count === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 text-center mb-8">
          <p className="text-gray-500 text-sm mb-4">No meals logged yet today.</p>
          <Link
            to="/log-meal"
            className="inline-block bg-[#E8670A] text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:bg-[#c45e09] transition-colors"
          >
            Log your first meal
          </Link>
        </div>
      )}

      {/* Weight Journey */}
      {!loading && userProfile?.starting_weight_lbs != null && (
        <>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Weight Journey</h2>
          <div className="grid grid-cols-3 gap-3 mb-8">
            <StatCard
              label="Starting Weight"
              value={`${userProfile.starting_weight_lbs} lbs`}
              color="text-gray-700"
            />
            <StatCard
              label="Current Weight"
              value={
                todayLog?.weight_lbs != null
                  ? `${todayLog.weight_lbs} lbs`
                  : weekLog?.avg_weight != null
                    ? `${weekLog.avg_weight} lbs`
                    : '—'
              }
              color="text-purple-500"
            />
            <StatCard
              label="Total Lost"
              value={(() => {
                const current = todayLog?.weight_lbs ?? weekLog?.avg_weight
                if (current == null) return '—'
                const lost = (userProfile.starting_weight_lbs - current).toFixed(1)
                return `${lost} lbs`
              })()}
              color="text-[#E8670A]"
            />
          </div>
        </>
      )}

      {/* Goals */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Your Goals</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {[
          { label: 'Goal Calories', value: userProfile?.goal_calories != null ? userProfile.goal_calories.toLocaleString() : '—', color: 'text-orange-500' },
          { label: 'Goal Protein',  value: userProfile?.goal_protein  != null ? `${userProfile.goal_protein}g`  : '—', color: 'text-blue-600' },
          { label: 'Goal Carbs',    value: userProfile?.goal_carbs    != null ? `${userProfile.goal_carbs}g`    : '—', color: 'text-yellow-500' },
          { label: 'Goal Fat',      value: userProfile?.goal_fat      != null ? `${userProfile.goal_fat}g`      : '—', color: 'text-pink-500' },
        ].map(s => (
          <StatCard key={s.label} label={s.label} value={loading ? '…' : s.value} color={s.color} sub="set by coach" />
        ))}
      </div>

      {/* Daily Tracking inputs */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Log Today</h2>
      <div className="grid grid-cols-3 gap-3 mb-10">
        {trackers.map((t) => (
          <TrackerCard
            key={t.field}
            label={t.label}
            unit={t.unit}
            field={t.field}
            currentValue={loading ? null : t.currentValue}
            onSave={saveTracker}
          />
        ))}
      </div>

      {/* Weekly Summary */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">This Week</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {weekStats.map((s) => (
          <StatCard key={s.label} label={s.label} value={loading ? '…' : s.value} color={s.color} />
        ))}
      </div>
    </div>
  )
}
