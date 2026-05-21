import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { Link } from 'react-router-dom'
import { API_URL } from '../config.js'
import MicronutrientTotals, { calculateMicronutrientTotals } from '../components/MicronutrientTotals.jsx'

// ── Identity Momentum Card ────────────────────────────────────────────────────

const REFLECTION_PROMPTS = [
  'What win are you proud of this week?',
  'Where did you rebuild self-trust?',
  'What is one small promise for next week?',
]

// Stage → subtle accent color pair [bg, text]
const STAGE_COLORS = {
  'Starting Strong':     ['bg-sky-50',     'text-sky-700'],
  'Momentum Builder':    ['bg-violet-50',  'text-violet-700'],
  'Self-Trust Builder':  ['bg-blue-50',    'text-blue-700'],
  'Consistency Warrior': ['bg-emerald-50', 'text-emerald-700'],
  'Resilient Warrior':   ['bg-amber-50',   'text-amber-700'],
  'Life Warrior':        ['bg-orange-50',  'text-[#c45e09]'],
}

function MomentumCard({ data, loading }) {
  const [reflOpen, setReflOpen] = useState(false)

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 mb-5 overflow-hidden animate-pulse">
        <div className="px-4 pt-3 pb-2 border-b border-gray-100">
          <div className="h-3 bg-gray-100 rounded w-28 mb-1.5" />
          <div className="h-4 bg-gray-100 rounded w-40" />
        </div>
        <div className="px-4 py-3">
          <div className="flex gap-2 mb-2.5">
            {[...Array(5)].map((_, i) => <div key={i} className="h-7 w-20 bg-gray-100 rounded-full" />)}
          </div>
          <div className="h-3 bg-gray-100 rounded w-56" />
        </div>
      </div>
    )
  }
  if (!data) return null

  const stage = data.identity_stage ?? 'Starting Strong'
  const [stageBg, stageText] = STAGE_COLORS[stage] ?? ['bg-gray-50', 'text-gray-700']

  return (
    <div className="bg-white rounded-2xl border border-gray-200 mb-5 overflow-hidden">

      {/* Stage header */}
      <div className="px-4 pt-3 pb-2.5 border-b border-gray-100">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-0.5">
          Identity Stage
        </p>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-bold text-gray-900">{stage}</p>
          <span className={`shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-full ${stageBg} ${stageText}`}>
            Week {data.active_weeks ?? 0} of consistency
          </span>
        </div>
      </div>

      {/* Pillars + message */}
      <div className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5 mb-2.5">
          {data.categories.map(c => (
            <span
              key={c.key}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                c.active ? 'bg-[#fde8c8] text-[#c45e09]' : 'bg-gray-100 text-gray-400'
              }`}
            >
              {c.icon} {c.label}
            </span>
          ))}
        </div>

        {/* Stage description — mature, identity-framing language */}
        <p className="text-xs text-gray-600 leading-relaxed">
          {data.stage_description ?? data.message}
        </p>

        {/* Comeback banner */}
        {data.is_comeback && data.comeback_message && (
          <div className="mt-2.5 rounded-lg px-3 py-2 bg-emerald-50 border border-emerald-100">
            <p className="text-xs font-semibold text-emerald-700">{data.comeback_message}</p>
          </div>
        )}
      </div>

      {/* Weekly reflection prompt — collapsible, display-only */}
      <div className="px-4 pb-3 border-t border-gray-100 pt-2.5">
        <button
          onClick={() => setReflOpen(v => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg
            className={`w-3 h-3 transition-transform ${reflOpen ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          Weekly Reflection
        </button>
        {reflOpen && (
          <div className="mt-2 space-y-2">
            {REFLECTION_PROMPTS.map((prompt, i) => (
              <p key={i} className="text-xs text-gray-500 pl-3 border-l-2 border-[#fde8c8] leading-relaxed">
                {prompt}
              </p>
            ))}
            <p className="text-[10px] text-gray-400 pl-3">
              Share your answers in your weekly check-in with your coach.
            </p>
          </div>
        )}
      </div>
    </div>
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

function TrackerCard({ label, unit, field, currentValue, onSave, clearable = false }) {
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

  async function handleClear() {
    setSaving(true)
    try {
      await onSave(field, null)  // explicit null → backend clears value + source
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
          <div className="flex gap-1.5 justify-center mb-1.5">
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
          {clearable && currentValue != null && (
            <button
              onClick={handleClear}
              disabled={saving}
              className="w-full text-[11px] text-gray-400 hover:text-red-500 py-0.5 min-h-[28px] transition-colors disabled:opacity-50"
            >
              Clear (let sync fill)
            </button>
          )}
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
          <p className="text-sm font-semibold text-gray-700">Status-Flagged Clients</p>
          <Link to="/admin/clients" className="text-xs text-[#E8670A] hover:text-[#c45e09] font-medium">View all →</Link>
        </div>
        {loading ? (
          <p className="text-sm text-gray-400 py-6 text-center">Loading…</p>
        ) : needsAttention.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-4 text-center">
            <p className="text-sm text-gray-500">No status flags right now.</p>
            {noRecentLogs.length === 0 && msgUnread === 0 && checkins.length === 0 && (
              <p className="text-xs text-gray-400 mt-0.5">All clients are on track.</p>
            )}
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

// ── Progress Photos ───────────────────────────────────────────────────────────

const ANGLES = ['front', 'side', 'back']

function generateSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function fmtSessionDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// A single read-only set row: date + optional weight chip + 3-col photo grid
function SessionSetView({ session, weight }) {
  const photoCount = ANGLES.filter(a => session.photos[a]).length
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-gray-700">{fmtSessionDate(session.session_date)}</span>
        {weight != null && (
          <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">
            {weight} lbs
          </span>
        )}
        <span className="text-[10px] text-gray-400 ml-auto">{photoCount}/3</span>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {ANGLES.map(a => {
          const p = session.photos[a]
          return (
            <div key={a} className="text-center">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1 capitalize">{a}</p>
              {p ? (
                <a
                  href={p.photo_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full aspect-[3/4] rounded-xl overflow-hidden bg-gray-100 hover:opacity-85 transition-opacity"
                >
                  <img src={p.photo_url} alt={a} className="w-full h-full object-cover" />
                </a>
              ) : (
                <div className="w-full aspect-[3/4] rounded-xl bg-gray-50 border border-dashed border-gray-200 flex items-center justify-center">
                  <span className="text-[10px] text-gray-300">—</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Latest session with upload capability per slot
function UploadPhotoSlot({ angle, photo, sessionId, uploading, onFileSelected }) {
  const inputRef    = useRef(null)
  const isUploading = uploading === angle

  return (
    <div className="text-center">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1 capitalize">{angle}</p>
      <div
        onClick={() => !isUploading && inputRef.current?.click()}
        className={`w-full aspect-[3/4] rounded-xl overflow-hidden cursor-pointer transition-all flex items-center justify-center border-2 ${
          photo
            ? 'border-gray-200 hover:opacity-85'
            : 'border-dashed border-gray-300 bg-gray-50 hover:border-[#E8670A] hover:bg-[#fff7ed]'
        }`}
      >
        {photo ? (
          <img src={photo.photo_url} alt={angle} className="w-full h-full object-cover" />
        ) : isUploading ? (
          <span className="text-[10px] text-gray-400">Uploading…</span>
        ) : (
          <span className="text-[10px] text-gray-400 px-1 text-center leading-snug">Tap to add</span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => e.target.files[0] && onFileSelected(angle, e.target.files[0], sessionId)}
      />
    </div>
  )
}

function ProgressPhotosCard({ sessions, getToken, onUploaded, onNewSession, latestWeight }) {
  const [uploading,    setUploading]    = useState(null)
  const [historyOpen,  setHistoryOpen]  = useState(false)

  const latest = sessions[0] ?? null
  const older  = sessions.slice(1)

  async function handleFileSelected(angle, file, sessionId) {
    setUploading(angle)
    try {
      const token = await getToken()
      const body  = new FormData()
      body.append('photo', file)
      body.append('angle', angle)
      body.append('session_id', sessionId)
      const res = await fetch(`${API_URL}/api/progress-photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      })
      if (res.ok) onUploaded(await res.json())
    } finally {
      setUploading(null)
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-8">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-gray-100">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Progress Photos</h2>
          <p className="text-[10px] text-gray-400 mt-0.5">
            {sessions.length === 0
              ? 'No sets yet'
              : `${sessions.length} ${sessions.length === 1 ? 'set' : 'sets'}`}
          </p>
        </div>
        <button
          onClick={onNewSession}
          className="flex items-center gap-1 bg-[#E8670A] text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-[#c45e09] transition-colors min-h-[36px]"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Set
        </button>
      </div>

      {!latest ? (
        /* Empty state */
        <div className="px-4 py-7 text-center">
          <p className="text-sm text-gray-400 mb-1">No progress photos yet.</p>
          <p className="text-xs text-gray-300">Tap "New Set" to add your first front, side &amp; back photos.</p>
        </div>
      ) : (
        <div className="px-4 pt-3 pb-1">
          {/* Latest set: date + weight + upload slots */}
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-xs font-semibold text-gray-700">{fmtSessionDate(latest.session_date)}</span>
            {latestWeight != null && (
              <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">
                {latestWeight} lbs
              </span>
            )}
            <span className="text-[10px] text-gray-400 ml-auto">
              {ANGLES.filter(a => latest.photos[a]).length}/3
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-3">
            {ANGLES.map(angle => (
              <UploadPhotoSlot
                key={angle}
                angle={angle}
                photo={latest.photos[angle]}
                sessionId={latest.session_id}
                uploading={uploading}
                onFileSelected={handleFileSelected}
              />
            ))}
          </div>

          {/* History toggle */}
          {older.length > 0 && (
            <div className="border-t border-gray-100 pt-2 pb-2">
              <button
                onClick={() => setHistoryOpen(v => !v)}
                className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-400 hover:text-[#E8670A] transition-colors min-h-[36px] w-full"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${historyOpen ? 'rotate-90' : ''}`}
                  fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                {historyOpen
                  ? 'Hide history'
                  : `Show ${older.length} older ${older.length === 1 ? 'set' : 'sets'}`}
              </button>

              {historyOpen && (
                <div className="space-y-5 pt-3 pb-1">
                  {older.map(s => (
                    <SessionSetView key={s.session_id} session={s} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── New-session upload modal ──────────────────────────────────────────────────

function NewSessionModal({ sessionId, getToken, onUploaded, onClose }) {
  const [uploading, setUploading] = useState(null)
  const [done,      setDone]      = useState({ front: false, side: false, back: false })
  const frontRef = useRef(null)
  const sideRef  = useRef(null)
  const backRef  = useRef(null)
  const inputRefs = { front: frontRef, side: sideRef, back: backRef }

  async function handleFile(angle, file) {
    setUploading(angle)
    try {
      const token = await getToken()
      const body  = new FormData()
      body.append('photo', file)
      body.append('angle', angle)
      body.append('session_id', sessionId)
      const res = await fetch(`${API_URL}/api/progress-photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      })
      if (res.ok) {
        onUploaded(await res.json())
        setDone(d => ({ ...d, [angle]: true }))
      }
    } finally {
      setUploading(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white w-full max-w-sm rounded-t-2xl sm:rounded-2xl p-5 pb-8 sm:pb-5 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-gray-900">New Photo Set</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none min-h-[44px] min-w-[44px] flex items-center justify-center"
          >✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Add front, side, and back photos. You can skip angles — partial sets save safely.
        </p>
        <div className="grid grid-cols-3 gap-3 mb-5">
          {ANGLES.map(angle => (
            <div key={angle} className="text-center">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5 capitalize">{angle}</p>
              <div
                onClick={() => !uploading && inputRefs[angle].current?.click()}
                className={`w-full aspect-[3/4] rounded-xl overflow-hidden cursor-pointer border-2 flex items-center justify-center transition-all ${
                  done[angle]
                    ? 'border-emerald-400 bg-emerald-50'
                    : uploading === angle
                      ? 'border-gray-200 bg-gray-50'
                      : 'border-dashed border-gray-300 bg-gray-50 hover:border-[#E8670A] hover:bg-[#fff7ed]'
                }`}
              >
                {done[angle] ? (
                  <span className="text-emerald-500 text-xl">✓</span>
                ) : uploading === angle ? (
                  <span className="text-[10px] text-gray-400">Uploading…</span>
                ) : (
                  <span className="text-[10px] text-gray-400 px-1 text-center leading-snug">Tap to add</span>
                )}
              </div>
              <input
                ref={inputRefs[angle]}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => e.target.files[0] && handleFile(angle, e.target.files[0])}
              />
            </div>
          ))}
        </div>
        <button
          onClick={onClose}
          className="w-full py-2.5 rounded-xl text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors min-h-[44px]"
        >
          {Object.values(done).some(Boolean) ? 'Done' : 'Cancel'}
        </button>
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
  const [photoSessions, setPhotoSessions] = useState([])
  const [newSessionId,  setNewSessionId]  = useState(null) // when set, shows upload modal

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token   = await getToken()
        const headers = { Authorization: `Bearer ${token}` }
        const today   = new Date().toLocaleDateString('sv')

        // Fire proactive check non-blocking, then fetch latest banner
        fetch(`${API_URL}/api/coach/check-proactive`, { method: 'POST', headers }).catch(() => {})

        const [r1, r2, r3, r4, r5, r6, r7, r8, r9] = await Promise.all([
          fetch(`${API_URL}/api/meals/today?date=${today}`, { headers }),
          fetch(`${API_URL}/api/daily-logs/today`, { headers }),
          fetch(`${API_URL}/api/meals/week`,       { headers }),
          fetch(`${API_URL}/api/daily-logs/week`,  { headers }),
          fetch(`${API_URL}/api/users/me`,         { headers }),
          fetch(`${API_URL}/api/meals?date=${today}`, { headers }),
          fetch(`${API_URL}/api/coach/latest-proactive`, { headers }),
          fetch(`${API_URL}/api/gamification/momentum`, { headers }),
          fetch(`${API_URL}/api/progress-photos`,  { headers }),
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
          if (r9.ok) setPhotoSessions(await r9.json())
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

  function handlePhotoUploaded(photo) {
    // photo has: { id, photo_url, angle, taken_at, session_id }
    setPhotoSessions(prev => {
      const idx = prev.findIndex(s => s.session_id === photo.session_id)
      if (idx >= 0) {
        // Update existing session
        const updated = [...prev]
        updated[idx] = {
          ...updated[idx],
          photos: { ...updated[idx].photos, [photo.angle]: photo },
        }
        // Move to front if it's the one being added to (in case sort changed)
        return updated
      } else {
        // New session — prepend to list
        const newSession = {
          session_id:   photo.session_id,
          session_date: photo.taken_at,
          photos:       { front: null, side: null, back: null, [photo.angle]: photo },
        }
        return [newSession, ...prev]
      }
    })
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
    { label: 'Steps',  unit: 'steps', field: 'steps',      currentValue: todayLog?.steps,      clearable: true },
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

      {/* Identity Momentum */}
      <MomentumCard data={gamData} loading={gamLoading} />

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
            clearable={t.clearable ?? false}
          />
        ))}
      </div>

      {/* Progress Photos */}
      <ProgressPhotosCard
        sessions={photoSessions}
        getToken={getToken}
        onUploaded={handlePhotoUploaded}
        onNewSession={() => setNewSessionId(generateSessionId())}
        latestWeight={todayLog?.weight_lbs ?? weekLog?.avg_weight ?? null}
      />

      {newSessionId && (
        <NewSessionModal
          sessionId={newSessionId}
          getToken={getToken}
          onUploaded={handlePhotoUploaded}
          onClose={() => setNewSessionId(null)}
        />
      )}

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
