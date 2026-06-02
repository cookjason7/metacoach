import { useEffect, useRef, useState } from 'react'
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

      {/* Coaching line — hide noisy auto-generated sentences */}
      {(() => {
        const FILTERED = new Set([
          "Coming back is a choice — and you made it. That's self-trust in action.",
          "Every Life Warrior starts with a single consistent week. This is yours.",
        ])
        const desc = data.stage_description ?? data.message
        if (desc && !FILTERED.has(desc)) {
          return <p className="text-xs text-gray-500 leading-relaxed">{desc}</p>
        }
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

// Returns which nutrition-target mode is active based on set goals.
// Mirrors the 3 modes in the coach's Nutrition Targets card.
function nutritionMode(userProfile) {
  const hasProtein = (userProfile?.goal_protein ?? 0) > 0
  const hasCarbs   = (userProfile?.goal_carbs   ?? 0) > 0
  const hasFat     = (userProfile?.goal_fat     ?? 0) > 0
  if (hasCarbs || hasFat) return 'full_macros'
  if (hasProtein)         return 'calories_protein'
  return 'calories_only'
}

function TodayGoals({ userProfile, todayMeals, loading }) {
  const mode = nutritionMode(userProfile)

  const macroRings = {
    calories: { label: 'Calories', current: todayMeals?.total_calories ?? 0, goal: userProfile?.goal_calories ?? 0, color: '#f97316', unit: 'cal' },
    protein:  { label: 'Protein',  current: todayMeals?.total_protein  ?? 0, goal: userProfile?.goal_protein  ?? 0, color: '#3b82f6', unit: 'g'   },
    carbs:    { label: 'Carbs',    current: todayMeals?.total_carbs    ?? 0, goal: userProfile?.goal_carbs    ?? 0, color: '#eab308', unit: 'g'   },
    fat:      { label: 'Fat',      current: todayMeals?.total_fat      ?? 0, goal: userProfile?.goal_fat      ?? 0, color: '#ec4899', unit: 'g'   },
  }

  const rings =
    mode === 'full_macros'      ? [macroRings.calories, macroRings.protein, macroRings.carbs, macroRings.fat] :
    mode === 'calories_protein' ? [macroRings.calories, macroRings.protein] :
    /* calories_only */           [macroRings.calories]

  if (loading) {
    // Default skeleton: 2 circles while data loads
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 animate-pulse">
        <div className="h-4 bg-gray-100 rounded w-28 mb-4" />
        <div className="grid grid-cols-2 gap-3 max-w-[200px] mx-auto justify-items-center">
          {[0, 1].map(i => (
            <div key={i} className="flex flex-col items-center gap-1.5">
              <div className="rounded-full bg-gray-100" style={{ width: 80, height: 80 }} />
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
      {rings.length === 1 ? (
        <div className="flex justify-center py-1">
          <GoalRing {...rings[0]} dim={92} />
        </div>
      ) : rings.length === 2 ? (
        <div className="grid grid-cols-2 gap-6 max-w-[220px] mx-auto justify-items-center">
          {rings.map(ring => <GoalRing key={ring.label} {...ring} dim={80} />)}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-y-5 gap-x-1 justify-items-center">
          {rings.map(ring => <GoalRing key={ring.label} {...ring} dim={68} />)}
        </div>
      )}
    </div>
  )
}

// ── Today's Habits ────────────────────────────────────────────────────────────

// For numeric habits whose unit maps to a live-tracked metric, return the
// current real-time value from todayLog / todayMeals. Returns null for habits
// that are NOT auto-tracked (they stay as plain checkboxes).
function getProgressCurrent(habit, todayLog, todayMeals) {
  if (habit.habit_type !== 'numeric' || !habit.target_value) return null
  const unit = (habit.unit ?? '').trim().toLowerCase()
  if (unit === 'oz')    return parseFloat(todayLog?.water_oz ?? 0)
  if (/^steps?$/.test(unit)) return todayLog?.steps ?? 0
  if (unit === 'g' && /fiber/i.test(habit.habit_name ?? '')) {
    return parseFloat(todayMeals?.total_fiber ?? 0)
  }
  return null  // not auto-tracked — stays as a manual checkbox
}

function fmtProgress(val) {
  if (val == null) return '—'
  const v = Math.round(val)
  return v >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(v)
}

function TodayHabits({ getToken, todayLog, todayMeals }) {
  const today           = new Date().toLocaleDateString('sv')
  const [habits,   setHabits]   = useState([])
  const [loading,  setLoading]  = useState(true)
  const [toggling, setToggling] = useState(null)
  // Tracks habit IDs we've already auto-completed this session to avoid
  // repeated API calls when live data re-renders after the target is met.
  const autoCompletedRef = useRef(new Set())

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

  // Auto-complete progress habits when live data shows target reached.
  // Fires at most once per habit per session (autoCompletedRef guard).
  // Uses ON CONFLICT DO UPDATE on the server so repeated calls are idempotent,
  // but we avoid the extra round-trips with the ref.
  useEffect(() => {
    if (!habits.length || loading) return
    const toComplete = []
    for (const item of habits) {
      const { habit, completion } = item
      const currentVal = getProgressCurrent(habit, todayLog, todayMeals)
      if (currentVal === null) continue
      if (completion?.status === 'complete') continue  // already done
      if (autoCompletedRef.current.has(habit.id)) continue  // already fired this session
      const pct = (currentVal / Number(habit.target_value)) * 100
      if (pct >= 80) toComplete.push({ habit, currentVal })
    }
    if (!toComplete.length) return

    toComplete.forEach(({ habit }) => autoCompletedRef.current.add(habit.id))

    ;(async () => {
      const token = await getToken()
      const results = await Promise.all(toComplete.map(async ({ habit, currentVal }) => {
        try {
          const res = await fetch(`${API_URL}/api/client-habits/me/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ habit_id: habit.id, completion_date: today, completed_value: currentVal }),
          })
          if (res.ok) return { habitId: habit.id, comp: await res.json() }
        } catch {}
        return null
      }))
      const updates = results.filter(Boolean)
      if (updates.length) {
        setHabits(prev => prev.map(h => {
          const u = updates.find(x => x.habitId === h.habit.id)
          return u ? { ...h, completion: u.comp } : h
        }))
      }
    })()
  }, [habits, todayLog, todayMeals, loading, today, getToken])

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
        // Remove from auto-completed set so it can fire again if target is still met
        autoCompletedRef.current.delete(habit.id)
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

  // Filter out habits with blank habit_name or raw-numeric-only names (safety net)
  const NUMERIC_ONLY = /^\d+(\.\d+)?(\s*(oz|steps|lbs|g|mg|ml|kcal|cal|min|hrs|minutes|hours))?$/i
  const visibleHabits = habits.filter(item => {
    const name = item.habit?.habit_name?.trim()
    return name && !NUMERIC_ONLY.test(name)
  })

  const doneCount = visibleHabits.filter(h => h.completion?.status === 'complete').length

  return (
    <div className="bg-white rounded-2xl border border-gray-200 mb-4 overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-gray-100">
        <h2 className="text-sm font-bold text-gray-900">Today's Habits</h2>
        {visibleHabits.length > 0 && (
          <span className="text-xs font-semibold text-gray-400">{doneCount}/{visibleHabits.length}</span>
        )}
      </div>

      {visibleHabits.length === 0 ? (
        <p className="px-4 py-5 text-sm text-gray-400 text-center">No habits scheduled for today.</p>
      ) : (
        <div className="px-4 py-1">
          {visibleHabits.map(item => {
            const { habit, completion } = item
            const busy        = toggling === habit.id

            // Determine if this is a live-tracked progress habit
            const currentVal  = getProgressCurrent(habit, todayLog, todayMeals)
            const isProgress  = currentVal !== null
            const target      = isProgress ? Number(habit.target_value) : null
            const livePct     = isProgress ? Math.min(100, (currentVal / target) * 100) : 0
            const dbPct       = completion?.completion_percentage ?? 0
            // Display uses the higher of live data or stored percentage
            const displayPct  = isProgress ? Math.max(livePct, dbPct) : dbPct
            const done        = displayPct >= 80 || completion?.status === 'complete'
            const partial     = !done && (displayPct >= 50 || completion?.status === 'partial')

            return (
              <button
                key={habit.id}
                onClick={() => !busy && toggle(item)}
                disabled={busy}
                className="w-full flex items-start gap-3 py-3 border-b border-gray-50 last:border-0 text-left active:bg-gray-50 rounded-lg transition-colors disabled:opacity-60"
              >
                {/* Circle indicator */}
                <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 transition-all ${
                  done    ? 'bg-[#E8670A] border-[#E8670A]' :
                  partial ? 'bg-orange-100 border-orange-300' : 'border-gray-300'
                }`}>
                  {done && (
                    <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {!done && partial && <div className="w-2 h-2 rounded-full bg-orange-400" />}
                </div>

                <div className="flex-1 min-w-0">
                  {/* Habit name */}
                  <p className={`text-sm font-medium leading-snug ${done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                    {habit.habit_name}
                  </p>
                  {habit.notes && !done && (
                    <p className="text-xs text-gray-400 leading-snug mt-0.5 truncate">{habit.notes}</p>
                  )}

                  {/* Progress bar + values for auto-tracked habits */}
                  {isProgress && !done && (
                    <div className="mt-2">
                      <div className="flex justify-between text-[11px] text-gray-400 mb-1">
                        <span>{fmtProgress(currentVal)} / {fmtProgress(target)}{habit.unit ? ` ${habit.unit}` : ''}</span>
                        <span>{Math.round(displayPct)}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500 bg-[#E8670A]"
                          style={{ width: `${displayPct}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {isProgress && done && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      {fmtProgress(currentVal)} / {fmtProgress(target)}{habit.unit ? ` ${habit.unit}` : ''} · Goal reached ✓
                    </p>
                  )}
                </div>

                {/* Target badge for non-progress numeric habits */}
                {!isProgress && habit.habit_type === 'numeric' && habit.target_value != null && !done && (
                  <span className="text-[11px] font-medium text-gray-400 shrink-0 mt-0.5">
                    {habit.target_value}{habit.unit ? ` ${habit.unit}` : ''}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
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

      {/* Circular goal progress rings — nutrition targets only */}
      <TodayGoals
        userProfile={userProfile}
        todayMeals={todayMeals}
        loading={loading}
      />

      {/* Today's habits — syncs with Calendar; progress habits auto-update */}
      <TodayHabits getToken={getToken} todayLog={todayLog} todayMeals={todayMeals} />

    </div>
  )
}
