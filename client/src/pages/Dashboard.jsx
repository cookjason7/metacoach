import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { Link } from 'react-router-dom'
import { API_URL } from '../config.js'
import MicronutrientTotals, { calculateMicronutrientTotals } from '../components/MicronutrientTotals.jsx'
import CoachDashboard from './CoachDashboard'

// ── Constants ─────────────────────────────────────────────────────────────────

const REFLECTION_PROMPTS = [
  'What win are you proud of this week?',
  'Where did you rebuild self-trust?',
  'What is one small promise for next week?',
]

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
  const [reflOpen, setReflOpen] = useState(false)

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 mb-4 p-4 animate-pulse">
        <div className="flex items-center justify-between mb-2">
          <div className="h-4 bg-gray-100 rounded w-36" />
          <div className="h-5 w-20 bg-gray-100 rounded-full" />
        </div>
        <div className="h-3 bg-gray-100 rounded w-52" />
      </div>
    )
  }
  if (!data) return null

  const stage = data.identity_stage ?? 'Starting Strong'
  const [stageBg, stageText] = STAGE_COLORS[stage] ?? ['bg-gray-50', 'text-gray-700']

  return (
    <div className="bg-white rounded-2xl border border-gray-200 mb-4 overflow-hidden">
      <div className="px-4 pt-3.5 pb-3">
        {/* Stage + week badge */}
        <div className="flex items-start justify-between gap-2 mb-1.5">
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

        {/* One coaching / momentum line */}
        <p className="text-xs text-gray-500 leading-relaxed">
          {data.stage_description ?? data.message ?? ''}
        </p>

        {/* Comeback banner */}
        {data.is_comeback && data.comeback_message && (
          <div className="mt-2 rounded-lg px-3 py-2 bg-emerald-50 border border-emerald-100">
            <p className="text-xs font-semibold text-emerald-700">{data.comeback_message}</p>
          </div>
        )}
      </div>

      {/* Collapsible weekly reflection — subtle */}
      <div className="px-4 pb-3 pt-2.5 border-t border-gray-100">
        <button
          onClick={() => setReflOpen(v => !v)}
          className="flex items-center gap-1 text-[11px] font-medium text-gray-400 hover:text-gray-600 transition-colors min-h-[28px]"
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
          <div className="mt-2 space-y-1.5">
            {REFLECTION_PROMPTS.map((p, i) => (
              <p key={i} className="text-xs text-gray-500 pl-3 border-l-2 border-[#fde8c8] leading-relaxed">{p}</p>
            ))}
            <p className="text-[10px] text-gray-400 pl-3">
              Send your answers to your coach in Messages.
            </p>
          </div>
        )}
      </div>
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
  const cx   = dim / 2
  const r    = cx - 7            // 7 px from edge keeps stroke inside the viewBox
  const sw   = 6
  const circ = 2 * Math.PI * r
  const pct    = (goal > 0 && current != null) ? Math.min(current / goal, 1) : 0
  const offset = circ * (1 - pct)
  const done   = goal > 0 && current != null && current >= goal
  const hasGoal = goal > 0

  const valSize  = dim <= 64 ? 11 : 12  // px
  const unitSize = 8
  const lblSize  = dim <= 64 ? 10 : 11
  const goalSize = 9

  return (
    <div className="flex flex-col items-center" style={{ gap: 4 }}>
      <div className="relative" style={{ width: dim, height: dim }}>
        <svg width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`} style={{ transform: 'rotate(-90deg)' }}>
          {/* Track */}
          <circle cx={cx} cy={cx} r={r} fill="none" stroke="#f3f4f6" strokeWidth={sw} />
          {/* Progress or no-goal hint */}
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
              strokeDasharray={`${circ * 0.25} ${circ}`}
              opacity="0.3"
            />
          )}
        </svg>

        {/* Center text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ gap: 2 }}>
          <span style={{ fontSize: valSize, fontWeight: 700, color: '#111827', lineHeight: 1 }}>
            {fmtRingVal(current)}
          </span>
          {unit && (
            <span style={{ fontSize: unitSize, color: '#9ca3af', lineHeight: 1 }}>{unit}</span>
          )}
        </div>
      </div>

      <div className="text-center">
        <p style={{ fontSize: lblSize, fontWeight: 600, color: '#4b5563', lineHeight: 1.3 }}>{label}</p>
        {hasGoal && (
          <p style={{ fontSize: goalSize, color: '#9ca3af', lineHeight: 1.2 }}>
            / {fmtRingVal(goal)}
          </p>
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
    { label: 'Protein',  current: todayMeals?.total_protein  ?? 0, goal: userProfile?.goal_protein  ?? 0, color: '#3b82f6', unit: 'g' },
    { label: 'Carbs',    current: todayMeals?.total_carbs    ?? 0, goal: userProfile?.goal_carbs    ?? 0, color: '#eab308', unit: 'g' },
    { label: 'Fat',      current: todayMeals?.total_fat      ?? 0, goal: userProfile?.goal_fat      ?? 0, color: '#ec4899', unit: 'g' },
    { label: 'Water',    current: parseFloat(todayLog?.water_oz ?? 0), goal: waterGoal,                   color: '#06b6d4', unit: 'oz' },
    { label: 'Steps',    current: todayLog?.steps ?? 0,               goal: 10000,                        color: '#a855f7', unit: ''   },
  ] : [
    { label: 'Calories', current: todayMeals?.total_calories ?? 0, goal: userProfile?.goal_calories ?? 0, color: '#f97316', unit: 'cal' },
    { label: 'Protein',  current: todayMeals?.total_protein  ?? 0, goal: userProfile?.goal_protein  ?? 0, color: '#3b82f6', unit: 'g' },
    { label: 'Water',    current: parseFloat(todayLog?.water_oz ?? 0), goal: waterGoal,                   color: '#06b6d4', unit: 'oz' },
    { label: 'Steps',    current: todayLog?.steps ?? 0,               goal: 10000,                        color: '#a855f7', unit: ''   },
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
        {rings.map(ring => (
          <GoalRing key={ring.label} {...ring} dim={dim} />
        ))}
      </div>
    </div>
  )
}

// ── Today's Habits ────────────────────────────────────────────────────────────

function TodayHabits({ getToken }) {
  const today = new Date().toLocaleDateString('sv')   // YYYY-MM-DD
  const [habits,   setHabits]   = useState([])
  const [loading,  setLoading]  = useState(true)
  const [toggling, setToggling] = useState(null)       // habit_id currently toggling

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(
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
        // Un-complete
        await fetch(
          `${API_URL}/api/client-habits/me/completions/${habit.id}/${today}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        )
        setHabits(prev => prev.map(h =>
          h.habit.id === habit.id ? { ...h, completion: null } : h,
        ))
      } else {
        // Mark complete — numeric habits use target_value, boolean habits use 1
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

  if (habits.length === 0) return null   // no habits assigned today — hide section

  const doneCount = habits.filter(h => h.completion?.status === 'complete').length

  return (
    <div className="bg-white rounded-2xl border border-gray-200 mb-4 overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-gray-100">
        <h2 className="text-sm font-bold text-gray-900">Today's Habits</h2>
        <span className="text-xs font-semibold text-gray-400">{doneCount}/{habits.length}</span>
      </div>

      <div className="px-4 py-1">
        {habits.map(item => {
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
              {/* Circle checkbox */}
              <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                done    ? 'bg-[#E8670A] border-[#E8670A]' :
                partial ? 'bg-orange-100 border-orange-300' :
                          'border-gray-300'
              }`}>
                {done && (
                  <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {partial && <div className="w-2 h-2 rounded-full bg-orange-400" />}
              </div>

              {/* Habit label + optional description */}
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium leading-snug ${done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                  {habit.title}
                </p>
                {habit.description && !done && (
                  <p className="text-xs text-gray-400 leading-snug mt-0.5 truncate">{habit.description}</p>
                )}
              </div>

              {/* Target badge for numeric habits */}
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

// ── StatCard — used for Weight Journey ────────────────────────────────────────

function StatCard({ label, value, sub, color = 'text-gray-900', onClick }) {
  const inner = (
    <>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      {onClick && <p className="text-[10px] text-gray-300 mt-1">tap for breakdown</p>}
    </>
  )
  return onClick ? (
    <button onClick={onClick} className="bg-white rounded-xl border border-gray-200 p-4 text-left w-full hover:border-gray-300 active:bg-gray-50 transition-colors">
      {inner}
    </button>
  ) : (
    <div className="bg-white rounded-xl border border-gray-200 p-4">{inner}</div>
  )
}

// ── Nutrient Breakdown Bottom Sheet ──────────────────────────────────────────

function NutrientBreakdownSheet({ label, unit, total, decimals, items, onClose }) {
  function fmt(v) {
    return decimals === 0 ? Math.round(v).toLocaleString() : Number(v).toFixed(decimals)
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-white rounded-t-2xl shadow-2xl max-h-[70vh] flex flex-col pb-[env(safe-area-inset-bottom)]">
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
          <div>
            <p className="text-base font-bold text-gray-900">{label} Breakdown</p>
            <p className="text-sm text-gray-500">
              Total: <span className="font-semibold text-gray-700">{fmt(total)} {unit}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 text-lg leading-none"
          >×</button>
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-3">
          {items.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No breakdown data available.</p>
          ) : (
            <div className="space-y-2">
              {items.map((item, i) => (
                <div key={i} className="flex items-start justify-between gap-3 py-2 border-b border-gray-100 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-800 truncate">{item.meal_name}</p>
                    <p className="text-xs text-gray-400">
                      {item.meal_slot && <span>{item.meal_slot}</span>}
                      {item.serving_size != null && item.serving_unit && (
                        <span>{item.meal_slot ? ' · ' : ''}{item.serving_size} {item.serving_unit}</span>
                      )}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-gray-900 shrink-0">
                    {fmt(item.value)} <span className="text-xs font-normal text-gray-400">{unit}</span>
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ── Women's Health Foundation ─────────────────────────────────────────────────

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

function WomensHealthFoundation({ meals, waterOz }) {
  const micros = calculateMicronutrientTotals(meals)
  const getMicro = (key) => micros.find(m => m.key === key)?.value ?? 0

  const rings = [
    { label: 'Water',     value: parseFloat(waterOz) || 0, goal: 64,   unit: 'oz',  color: '#60A5FA' },
    { label: 'Calcium',   value: getMicro('calcium_mg'),    goal: 1200, unit: 'mg',  color: '#3B82F6' },
    { label: 'Vitamin D', value: getMicro('vitamin_d_mcg'), goal: 20,   unit: 'mcg', color: '#F59E0B' },
    { label: 'Iron',      value: getMicro('iron_mg'),       goal: 18,   unit: 'mg',  color: '#8B5CF6' },
  ]
  const overallPct = rings.reduce((s, r) => s + Math.min(r.goal > 0 ? r.value / r.goal : 0, 1), 0) / rings.length
  const statusLabel = p => p >= 0.8 ? 'On track' : p >= 0.5 ? 'Strong start' : p >= 0.2 ? 'Needs attention' : 'Low today'

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-6">
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
      <div className="grid grid-cols-4 gap-y-4 gap-x-2">
        {rings.map(r => <FoundationRing key={r.label} {...r} />)}
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
                <a href={p.photo_url} target="_blank" rel="noopener noreferrer"
                  className="block w-full aspect-[3/4] rounded-xl overflow-hidden bg-gray-100 hover:opacity-85 transition-opacity"
                >
                  <img src={p.photo_url} alt={a} className="w-full h-full object-contain" />
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
          <img src={photo.photo_url} alt={angle} className="w-full h-full object-contain" />
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
  const [uploading,   setUploading]   = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)

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
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-gray-100">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Progress Photos</h2>
          <p className="text-[10px] text-gray-400 mt-0.5">
            {sessions.length === 0 ? 'No sets yet' : `${sessions.length} ${sessions.length === 1 ? 'set' : 'sets'}`}
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
        <div className="px-4 py-7 text-center">
          <p className="text-sm text-gray-400 mb-1">No progress photos yet.</p>
          <p className="text-xs text-gray-300">Tap "New Set" to add your first front, side &amp; back photos.</p>
        </div>
      ) : (
        <div className="px-4 pt-3 pb-1">
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
                {historyOpen ? 'Hide history' : `Show ${older.length} older ${older.length === 1 ? 'set' : 'sets'}`}
              </button>
              {historyOpen && (
                <div className="space-y-5 pt-3 pb-1">
                  {older.map(s => <SessionSetView key={s.session_id} session={s} />)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── New Session Modal ─────────────────────────────────────────────────────────

function NewSessionModal({ sessionId, getToken, onUploaded, onClose }) {
  const [uploading,    setUploading]    = useState(null)
  const [previews,     setPreviews]     = useState({ front: null, side: null, back: null })
  const [uploaded,     setUploaded]     = useState({ front: false, side: false, back: false })
  const [uploadErrors, setUploadErrors] = useState({ front: null, side: null, back: null })
  const [menu,         setMenu]         = useState(null)

  const frontCamRef = useRef(null)
  const frontGalRef = useRef(null)
  const sideCamRef  = useRef(null)
  const sideGalRef  = useRef(null)
  const backCamRef  = useRef(null)
  const backGalRef  = useRef(null)
  const camRefs = { front: frontCamRef, side: sideCamRef, back: backCamRef }
  const galRefs = { front: frontGalRef, side: sideGalRef, back: backGalRef }

  const cameraActiveRef = useRef(false)
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible' && cameraActiveRef.current) {
        setTimeout(() => { cameraActiveRef.current = false }, 500)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  async function handleFile(angle, file) {
    setMenu(null)
    setUploadErrors(prev => ({ ...prev, [angle]: null }))
    const previewUrl = URL.createObjectURL(file)
    setPreviews(p => ({ ...p, [angle]: previewUrl }))
    setUploading(angle)
    let ok = false
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
        setUploaded(u => ({ ...u, [angle]: true }))
        ok = true
      }
    } catch {}
    finally {
      setUploading(null)
      if (!ok) {
        setPreviews(p => ({ ...p, [angle]: null }))
        setUploadErrors(prev => ({ ...prev, [angle]: 'Upload failed — tap to retry' }))
      }
    }
  }

  function captureAndHandle(angle, rawFile) {
    const reader = new FileReader()
    reader.onload = ev => {
      const blob = new Blob([ev.target.result], { type: rawFile.type })
      const safe = new File([blob], rawFile.name, { type: rawFile.type, lastModified: rawFile.lastModified })
      handleFile(angle, safe)
    }
    reader.readAsArrayBuffer(rawFile)
  }

  function openMenu(angle) {
    if (uploading) return
    setUploadErrors(prev => ({ ...prev, [angle]: null }))
    setMenu(prev => prev === angle ? null : angle)
  }

  return (
    <div
      className="mobile-modal-backdrop"
      onClick={e => { if (e.target === e.currentTarget && !cameraActiveRef.current) { setMenu(null); onClose() } }}
    >
      <div className="mobile-modal-panel max-w-sm">
        <div className="flex items-center justify-between px-5 pt-5 pb-4 shrink-0">
          <h3 className="text-base font-bold text-gray-900">New Photo Set</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none min-h-[44px] min-w-[44px] flex items-center justify-center"
          >✕</button>
        </div>

        <div className="mobile-modal-body px-5 pb-5">
          <div className="grid grid-cols-3 gap-3">
          {ANGLES.map(angle => {
            const preview     = previews[angle]
            const isUploading = uploading === angle
            const isDone      = uploaded[angle]
            const menuOpen    = menu === angle
            const uploadError = uploadErrors[angle]

            return (
              <div key={angle} className="text-center">
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5 capitalize">
                  {angle}
                </p>
                <div
                  onClick={() => !preview && !isUploading && openMenu(angle)}
                  className={`w-full aspect-[3/4] rounded-xl overflow-hidden border-2 relative flex items-center justify-center transition-all ${
                    preview
                      ? 'border-gray-200 cursor-default'
                      : menuOpen
                        ? 'border-[#E8670A] bg-[#fff7ed] cursor-pointer'
                        : isUploading
                          ? 'border-gray-200 bg-gray-50 cursor-default'
                          : uploadError
                            ? 'border-dashed border-red-300 bg-red-50 cursor-pointer'
                            : 'border-dashed border-gray-300 bg-gray-50 hover:border-[#E8670A] hover:bg-[#fff7ed] cursor-pointer'
                  }`}
                >
                  {preview ? (
                    <>
                      <img src={preview} alt={angle} className="w-full h-full object-contain" />
                      {isUploading && (
                        <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                          <span className="text-[10px] font-semibold text-white">Uploading…</span>
                        </div>
                      )}
                      {isDone && !isUploading && (
                        <div className="absolute top-1.5 right-1.5 w-5 h-5 bg-emerald-500 rounded-full flex items-center justify-center shadow">
                          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                      )}
                    </>
                  ) : menuOpen ? (
                    <div
                      className="w-full h-full flex flex-col gap-2 items-center justify-center p-2"
                      onClick={e => e.stopPropagation()}
                    >
                      <button
                        onClick={() => { cameraActiveRef.current = true; camRefs[angle].current?.click() }}
                        className="w-full flex items-center justify-center gap-1.5 bg-gray-900 text-white text-[11px] font-semibold py-2 rounded-lg min-h-[36px] active:bg-gray-700"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        Camera
                      </button>
                      <button
                        onClick={() => { galRefs[angle].current?.click() }}
                        className="w-full flex items-center justify-center gap-1.5 bg-gray-100 text-gray-700 text-[11px] font-semibold py-2 rounded-lg min-h-[36px] active:bg-gray-200"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        Gallery
                      </button>
                    </div>
                  ) : isUploading ? (
                    <span className="text-[10px] text-gray-400">Uploading…</span>
                  ) : uploadError ? (
                    <span className="text-[10px] text-red-500 px-1 text-center leading-snug">{uploadError}</span>
                  ) : (
                    <span className="text-[10px] text-gray-400 px-1 text-center leading-snug">Tap to add</span>
                  )}
                </div>

                <input
                  ref={camRefs[angle]}
                  type="file" accept="image/*" capture="environment"
                  className="hidden"
                  onChange={e => {
                    setTimeout(() => { cameraActiveRef.current = false }, 300)
                    const raw = e.target.files?.[0]
                    e.target.value = ''
                    if (raw) captureAndHandle(angle, raw)
                  }}
                />
                <input
                  ref={galRefs[angle]}
                  type="file" accept="image/*"
                  className="hidden"
                  onChange={e => {
                    const raw = e.target.files?.[0]
                    e.target.value = ''
                    if (raw) handleFile(angle, raw)
                  }}
                />
              </div>
            )
          })}
          </div>
        </div>

        <div className="mobile-modal-footer">
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors min-h-[44px]"
          >
            {Object.values(uploaded).some(Boolean) ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { getToken } = useAuth()

  const [todayMeals,    setTodayMeals]    = useState(null)
  const [mealRows,      setMealRows]      = useState([])
  const [todayLog,      setTodayLog]      = useState(null)
  const [weekLog,       setWeekLog]       = useState(null)
  const [userProfile,   setUserProfile]   = useState(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)
  const [katieBanner,   setKatieBanner]   = useState(null)
  const [gamData,       setGamData]       = useState(null)
  const [gamLoading,    setGamLoading]    = useState(true)
  const [photoSessions, setPhotoSessions] = useState([])
  const [newSessionId,  setNewSessionId]  = useState(null)
  const [breakdown,     setBreakdown]     = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token   = await getToken()
        const headers = { Authorization: `Bearer ${token}` }
        const today   = new Date().toLocaleDateString('sv')

        fetch(`${API_URL}/api/coach/check-proactive`, { method: 'POST', headers }).catch(() => {})

        const [r1, r2, r3, r4, r5, r6, r7, r8] = await Promise.all([
          fetch(`${API_URL}/api/meals/today?date=${today}`, { headers }),   // todayMeals
          fetch(`${API_URL}/api/daily-logs/today`,          { headers }),   // todayLog
          fetch(`${API_URL}/api/daily-logs/week`,           { headers }),   // weekLog (Weight Journey)
          fetch(`${API_URL}/api/users/me`,                  { headers }),   // userProfile
          fetch(`${API_URL}/api/meals?date=${today}`,       { headers }),   // mealRows (micros)
          fetch(`${API_URL}/api/coach/latest-proactive`,    { headers }),   // katie banner
          fetch(`${API_URL}/api/gamification/momentum`,     { headers }),   // gamData
          fetch(`${API_URL}/api/progress-photos`,           { headers }),   // photoSessions
        ])

        if (!r1.ok || !r2.ok || !r3.ok || !r4.ok || !r5.ok) throw new Error('Failed to load dashboard data')

        if (!cancelled) {
          const [m, l, wl, u, rows] = await Promise.all([
            r1.json(), r2.json(), r3.json(), r4.json(), r5.json(),
          ])
          setTodayMeals(m)
          setMealRows(rows)
          setTodayLog(l)
          setWeekLog(wl)
          setUserProfile(u)
          if (r6.ok) setKatieBanner((await r6.json()).message ?? null)
          if (r7.ok) setGamData(await r7.json())
          setGamLoading(false)
          if (r8.ok) setPhotoSessions(await r8.json())
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
    function onDailyLogUpdated(e) { if (e.detail) setTodayLog(e.detail) }
    window.addEventListener('daily-log-updated', onDailyLogUpdated)
    return () => window.removeEventListener('daily-log-updated', onDailyLogUpdated)
  }, [])

  function parseMicros(m) {
    if (!m) return null
    if (typeof m === 'object') return m
    try { return JSON.parse(m) } catch { return null }
  }

  function openMicroBreakdown(key, label, unit, decimals) {
    const items = mealRows
      .map(m => {
        const micro = parseMicros(m.micronutrients)
        return {
          meal_name: m.meal_name, meal_slot: m.meal_slot,
          serving_size: m.serving_size, serving_unit: m.serving_unit,
          value: micro?.[key] != null ? Number(micro[key]) : null,
        }
      })
      .filter(i => i.value != null && i.value > 0)
      .sort((a, b) => b.value - a.value)
    setBreakdown({ label, unit, total: items.reduce((s, i) => s + i.value, 0), decimals, items })
  }

  function handlePhotoUploaded(photo) {
    setPhotoSessions(prev => {
      const idx = prev.findIndex(s => s.session_id === photo.session_id)
      if (idx >= 0) {
        const updated = [...prev]
        updated[idx] = { ...updated[idx], photos: { ...updated[idx].photos, [photo.angle]: photo } }
        return updated
      }
      return [{
        session_id:   photo.session_id,
        session_date: photo.taken_at,
        photos:       { front: null, side: null, back: null, [photo.angle]: photo },
      }, ...prev]
    })
  }

  // Staff see the coaching dashboard
  if (!loading && (userProfile?.role === 'admin' || userProfile?.role === 'coach' || userProfile?.role === 'staff')) {
    return <CoachDashboard getToken={getToken} userRole={userProfile.role} />
  }

  return (
    <div>

      {/* Page header — Today only, no date picker */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Today</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {/* Identity card — compact */}
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

      {/* Today's habits — tap to check off, syncs with Calendar */}
      <TodayHabits getToken={getToken} />

      {/* Micronutrient detail */}
      <div className="mb-4">
        <MicronutrientTotals
          meals={mealRows}
          loading={loading}
          title="Today's Micronutrients"
          periodLabel="Today"
          exclude={['fiber_g']}
          onNutrientClick={(key, label, unit, decimals) => openMicroBreakdown(key, label, unit, decimals)}
        />
      </div>

      {breakdown && (
        <NutrientBreakdownSheet
          label={breakdown.label}
          unit={breakdown.unit}
          total={breakdown.total}
          decimals={breakdown.decimals}
          items={breakdown.items}
          onClose={() => setBreakdown(null)}
        />
      )}

      {/* Women's Health Foundation */}
      <WomensHealthFoundation meals={mealRows} waterOz={todayLog?.water_oz} />

      {/* Weight Journey */}
      {!loading && userProfile?.starting_weight_lbs != null && (
        <>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Weight Journey</h2>
          <div className="grid grid-cols-3 gap-3 mb-6">
            <StatCard
              label="Starting Weight"
              value={`${userProfile.starting_weight_lbs} lbs`}
              color="text-gray-700"
            />
            <StatCard
              label="Current Weight"
              value={
                todayLog?.weight_lbs != null  ? `${todayLog.weight_lbs} lbs` :
                weekLog?.avg_weight  != null  ? `${weekLog.avg_weight} lbs`  : '—'
              }
              color="text-purple-500"
            />
            <StatCard
              label="Total Lost"
              value={(() => {
                const cur = todayLog?.weight_lbs ?? weekLog?.avg_weight
                if (cur == null) return '—'
                return `${(userProfile.starting_weight_lbs - cur).toFixed(1)} lbs`
              })()}
              color="text-[#E8670A]"
            />
          </div>
        </>
      )}

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

    </div>
  )
}
