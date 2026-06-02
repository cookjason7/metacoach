import { useEffect, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { Link } from 'react-router-dom'
import { API_URL } from '../config.js'
import CoachDashboard from './CoachDashboard'

// ── Stage colours ─────────────────────────────────────────────────────────────

const STAGE_COLORS = {
  'Starting Strong':     ['bg-sky-50',     'text-sky-700'],
  'Momentum Builder':    ['bg-violet-50',  'text-violet-700'],
  'Self-Trust Builder':  ['bg-blue-50',    'text-blue-700'],
  'Consistency Warrior': ['bg-emerald-50', 'text-emerald-700'],
  'Resilient Warrior':   ['bg-amber-50',   'text-amber-700'],
  'Life Warrior':        ['bg-orange-50',  'text-[#c45e09]'],
}

// ── Compact Identity / Momentum Card ─────────────────────────────────────────

function MomentumCard({ data, loading }) {
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 mb-4 p-4 animate-pulse">
        <div className="flex items-center justify-between mb-2">
          <div className="h-4 bg-gray-100 rounded w-36" />
          <div className="h-5 w-20 bg-gray-100 rounded-full" />
        </div>
        <div className="flex gap-1.5 mb-2">
          {[...Array(4)].map((_, i) => <div key={i} className="h-5 w-16 bg-gray-100 rounded-full" />)}
        </div>
        <div className="h-3 bg-gray-100 rounded w-52" />
      </div>
    )
  }
  if (!data) return null

  const stage = data.identity_stage ?? 'Starting Strong'
  const [stageBg, stageText] = STAGE_COLORS[stage] ?? ['bg-gray-50', 'text-gray-700']

  return (
    <div className="bg-white rounded-2xl border border-gray-200 mb-4 px-4 pt-3.5 pb-4">

      {/* Stage name + week badge */}
      <div className="flex items-start justify-between gap-2 mb-2.5">
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest leading-none mb-0.5">
            Identity Stage
          </p>
          <p className="text-sm font-bold text-gray-900">{stage}</p>
        </div>
        <span className={`shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-full ${stageBg} ${stageText}`}>
          Week {data.active_weeks ?? 0}
        </span>
      </div>

      {/* Category badges */}
      {data.categories?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2.5">
          {data.categories.map(c => (
            <span
              key={c.key}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                c.active ? 'bg-[#fde8c8] text-[#c45e09]' : 'bg-gray-100 text-gray-400'
              }`}
            >
              {c.icon} {c.label}
            </span>
          ))}
        </div>
      )}

      {/* Coaching line — hide the comeback-specific sentence; show other stage descriptions */}
      {(() => {
        const COMEBACK_SENTENCE = "Coming back is a choice — and you made it. That's self-trust in action."
        const desc = data.stage_description ?? data.message
        if (desc && desc !== COMEBACK_SENTENCE) {
          return <p className="text-xs text-gray-500 leading-relaxed">{desc}</p>
        }
        // For comeback users replace the removed sentence with a simple status line
        if (data.is_comeback) {
          return <p className="text-xs text-gray-500">Current identity: <span className="font-semibold text-gray-700">{data.identity_stage ?? 'Resilient Warrior'}</span></p>
        }
        return null
      })()}
    </div>
  )
}

// ── Goal Progress Rings ───────────────────────────────────────────────────────

function fmtRingVal(n) {
  if (n == null) return '—'
  const v = Math.round(n)
  if (v >= 10000) return `${Math.round(v / 1000)}k`
  if (v >= 1000)  return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(v)
}

function GoalRing({ label, current, goal, color, unit, dim = 68 }) {
  const cx     = dim / 2
  const r      = cx - 7
  const sw     = 6
  const circ   = 2 * Math.PI * r
  const pct    = (goal > 0 && current != null) ? Math.min(current / goal, 1) : 0
  const offset = circ * (1 - pct)
  const done   = goal > 0 && current != null && current >= goal
  const hasGoal = goal > 0

  const valSize = dim <= 64 ? 11 : 12
  const lblSize = dim <= 64 ? 10 : 11

  return (
    <div className="flex flex-col items-center" style={{ gap: 4 }}>
      <div className="relative" style={{ width: dim, height: dim }}>
        <svg width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={cx} cy={cx} r={r} fill="none" stroke="#f3f4f6" strokeWidth={sw} />
          {hasGoal ? (
            <circle
              cx={cx} cy={cx} r={r} fill="none"
              stroke={done ? '#22c55e' : color}
              strokeWidth={sw} strokeLinecap="round"
              strokeDasharray={circ} strokeDashoffset={offset}
              style={{ transition: 'stroke-dashoffset 0.6s ease' }}
            />
          ) : (
            <circle
              cx={cx} cy={cx} r={r} fill="none"
              stroke={color} strokeWidth={sw} strokeLinecap="round"
              strokeDasharray={`${circ * 0.25} ${circ}`} opacity="0.3"
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ gap: 2 }}>
          <span style={{ fontSize: valSize, fontWeight: 700, color: '#111827', lineHeight: 1 }}>
            {fmtRingVal(current)}
          </span>
          {unit && (
            <span style={{ fontSize: 8, color: '#9ca3af', lineHeight: 1 }}>{unit}</span>
          )}
        </div>
      </div>
      <div className="text-center">
        <p style={{ fontSize: lblSize, fontWeight: 600, color: '#4b5563', lineHeight: 1.3 }}>{label}</p>
        {hasGoal && (
          <p style={{ fontSize: 9, color: '#9ca3af', lineHeight: 1.2 }}>/ {fmtRingVal(goal)}</p>
        )}
      </div>
    </div>
  )
}

function TodayGoals({ userProfile, todayMeals, todayLog, loading }) {
  const hasCarbs  = (userProfile?.goal_carbs ?? 0) > 0
  const hasFat    = (userProfile?.goal_fat   ?? 0) > 0
  const fullMacro = hasCarbs || hasFat
  const waterGoal = (userProfile?.goal_water ?? 0) > 0 ? userProfile.goal_water : 64

  const rings = fullMacro ? [
    { label: 'Calories', current: todayMeals?.total_calories ?? 0, goal: userProfile?.goal_calories ?? 0, color: '#f97316', unit: 'cal' },
    { label: 'Protein',  current: todayMeals?.total_protein  ?? 0, goal: userProfile?.goal_protein  ?? 0, color: '#3b82f6', unit: 'g'   },
    { label: 'Carbs',    current: todayMeals?.total_carbs    ?? 0, goal: userProfile?.goal_carbs    ?? 0, color: '#eab308', unit: 'g'   },
    { label: 'Fat',      current: todayMeals?.total_fat      ?? 0, goal: userProfile?.goal_fat      ?? 0, color: '#ec4899', unit: 'g'   },
    { label: 'Water',    current: parseFloat(todayLog?.water_oz ?? 0), goal: waterGoal,                   color: '#06b6d4', unit: 'oz'  },
    { label: 'Steps',    current: todayLog?.steps ?? 0,               goal: 10000,                        color: '#a855f7', unit: ''    },
  ] : [
    { label: 'Calories', current: todayMeals?.total_calories ?? 0, goal: userProfile?.goal_calories ?? 0, color: '#f97316', unit: 'cal' },
    { label: 'Protein',  current: todayMeals?.total_protein  ?? 0, goal: userProfile?.goal_protein  ?? 0, color: '#3b82f6', unit: 'g'   },
    { label: 'Water',    current: parseFloat(todayLog?.water_oz ?? 0), goal: waterGoal,                   color: '#06b6d4', unit: 'oz'  },
    { label: 'Steps',    current: todayLog?.steps ?? 0,               goal: 10000,                        color: '#a855f7', unit: ''    },
  ]

  const cols = fullMacro ? 'grid-cols-3' : 'grid-cols-4'
  const dim  = fullMacro ? 68 : 64

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 animate-pulse">
        <div className="h-4 bg-gray-100 rounded w-28 mb-4" />
        <div className={`grid ${cols} gap-3 justify-items-center`}>
          {rings.map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-1.5">
              <div className="rounded-full bg-gray-100" style={{ width: dim, height: dim }} />
              <div className="h-2.5 bg-gray-100 rounded w-10" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4">
      <h2 className="text-sm font-bold text-gray-900 mb-4">Today's Goals</h2>
      <div className={`grid ${cols} gap-y-5 gap-x-1 justify-items-center`}>
        {rings.map(ring => <GoalRing key={ring.label} {...ring} dim={dim} />)}
      </div>
    </div>
  )
}

// ── Today's Habits ────────────────────────────────────────────────────────────

function TodayHabits({ getToken }) {
  const today = new Date().toLocaleDateString('sv')
  const [habits,   setHabits]   = useState([])
  const [loading,  setLoading]  = useState(true)
  const [toggling, setToggling] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res   = await fetch(
          `${API_URL}/api/client-habits/me/calendar?start=${today}&end=${today}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (!res.ok || cancelled) return
        const data = await res.json()
        if (!cancelled) setHabits(data.calendar[today] ?? [])
      } catch {}
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [getToken, today])

  async function toggle(item) {
    const { habit, completion } = item
    const isDone = completion?.status === 'complete'
    setToggling(habit.id)
    try {
      const token = await getToken()
      if (isDone) {
        await fetch(
          `${API_URL}/api/client-habits/me/completions/${habit.id}/${today}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        )
        setHabits(prev => prev.map(h =>
          h.habit.id === habit.id ? { ...h, completion: null } : h,
        ))
      } else {
        const val = habit.habit_type === 'numeric' && habit.target_value != null
          ? Number(habit.target_value) : 1
        const res = await fetch(`${API_URL}/api/client-habits/me/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ habit_id: habit.id, completion_date: today, completed_value: val }),
        })
        if (res.ok) {
          const comp = await res.json()
          setHabits(prev => prev.map(h =>
            h.habit.id === habit.id ? { ...h, completion: comp } : h,
          ))
        }
      }
    } catch {}
    finally { setToggling(null) }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 mb-4 overflow-hidden animate-pulse">
        <div className="px-4 pt-3.5 pb-2.5 border-b border-gray-100">
          <div className="h-4 bg-gray-100 rounded w-28" />
        </div>
        <div className="px-4 py-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-3 border-b border-gray-50 last:border-0">
              <div className="w-6 h-6 rounded-full bg-gray-100 shrink-0" />
              <div className="h-3.5 bg-gray-100 rounded flex-1" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Filter out habits with blank or raw-numeric titles (e.g. "90.00 oz", "9000.00 steps")
  const NUMERIC_TITLE = /^\d+(\.\d+)?(\s*(oz|steps|lbs|g|mg|ml|kcal|cal|min|hrs|minutes|hours))?$/i
  const visibleHabits = habits.filter(item => {
    const t = item.habit?.title?.trim()
    return t && !NUMERIC_TITLE.test(t)
  })

  if (visibleHabits.length === 0) return null

  const doneCount = visibleHabits.filter(h => h.completion?.status === 'complete').length

  return (
    <div className="bg-white rounded-2xl border border-gray-200 mb-4 overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-gray-100">
        <h2 className="text-sm font-bold text-gray-900">Today's Habits</h2>
        <span className="text-xs font-semibold text-gray-400">{doneCount}/{visibleHabits.length}</span>
      </div>
      <div className="px-4 py-1">
        {visibleHabits.map(item => {
          const { habit, completion } = item
          const done    = completion?.status === 'complete'
          const partial = completion?.status === 'partial'
          const busy    = toggling === habit.id
          return (
            <button
              key={habit.id}
              onClick={() => !busy && toggle(item)}
              disabled={busy}
              className="w-full flex items-center gap-3 py-3 border-b border-gray-50 last:border-0 text-left active:bg-gray-50 rounded-lg transition-colors disabled:opacity-60"
            >
              <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                done    ? 'bg-[#E8670A] border-[#E8670A]' :
                partial ? 'bg-orange-100 border-orange-300' : 'border-gray-300'
              }`}>
                {done && (
                  <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {partial && <div className="w-2 h-2 rounded-full bg-orange-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium leading-snug ${done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                  {habit.title}
                </p>
                {habit.description && !done && (
                  <p className="text-xs text-gray-400 leading-snug mt-0.5 truncate">{habit.description}</p>
                )}
              </div>
              {habit.habit_type === 'numeric' && habit.target_value != null && !done && (
                <span className="text-[11px] font-medium text-gray-400 shrink-0">
                  {habit.target_value}{habit.unit ? ` ${habit.unit}` : ''}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Katie Banner ──────────────────────────────────────────────────────────────

function KatieBanner({ message, onDismiss }) {
  if (!message) return null
  return (
    <Link
      to="/ai-coach"
      className="flex items-start gap-3 bg-[#fff7ed] border border-[#fed7aa] rounded-xl px-4 py-3 mb-4 group hover:bg-[#ffedd5] transition-colors"
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

// (StatCard, FoundationRing, WomensHealthFoundation removed — not on Dashboard)

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { getToken } = useAuth()

  const [todayMeals,  setTodayMeals]  = useState(null)
  const [todayLog,    setTodayLog]    = useState(null)
  const [userProfile, setUserProfile] = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)
  const [katieBanner, setKatieBanner] = useState(null)
  const [gamData,     setGamData]     = useState(null)
  const [gamLoading,  setGamLoading]  = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token   = await getToken()
        const headers = { Authorization: `Bearer ${token}` }
        const today   = new Date().toLocaleDateString('sv')

        fetch(`${API_URL}/api/coach/check-proactive`, { method: 'POST', headers }).catch(() => {})

        const [r1, r2, r3, r4, r5] = await Promise.all([
          fetch(`${API_URL}/api/meals/today?date=${today}`, { headers }),  // todayMeals
          fetch(`${API_URL}/api/daily-logs/today`,          { headers }),  // todayLog
          fetch(`${API_URL}/api/users/me`,                  { headers }),  // userProfile
          fetch(`${API_URL}/api/coach/latest-proactive`,    { headers }),  // katie banner
          fetch(`${API_URL}/api/gamification/momentum`,     { headers }),  // gamData
        ])

        if (!r1.ok || !r2.ok || !r3.ok) throw new Error('Failed to load dashboard data')

        if (!cancelled) {
          const [m, l, u] = await Promise.all([r1.json(), r2.json(), r3.json()])
          setTodayMeals(m)
          setTodayLog(l)
          setUserProfile(u)
          if (r4.ok) setKatieBanner((await r4.json()).message ?? null)
          if (r5.ok) setGamData(await r5.json())
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

  useEffect(() => {
    function onUpdate(e) { if (e.detail) setTodayLog(e.detail) }
    window.addEventListener('daily-log-updated', onUpdate)
    return () => window.removeEventListener('daily-log-updated', onUpdate)
  }, [])

  // Staff → coaching dashboard
  if (!loading && (userProfile?.role === 'admin' || userProfile?.role === 'coach' || userProfile?.role === 'staff')) {
    return <CoachDashboard getToken={getToken} userRole={userProfile.role} />
  }

  return (
    <div>

      {/* Header — today only, no date picker */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Today</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {/* Identity card */}
      <MomentumCard data={gamData} loading={gamLoading} />

      {/* Coach Katie banner */}
      <KatieBanner message={katieBanner} onDismiss={() => setKatieBanner(null)} />

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          Could not load data: {error}
        </div>
      )}

      {/* Circular goal progress rings */}
      <TodayGoals
        userProfile={userProfile}
        todayMeals={todayMeals}
        todayLog={todayLog}
        loading={loading}
      />

      {/* Today's habits — syncs with Calendar */}
      <TodayHabits getToken={getToken} />

    </div>
  )
}
