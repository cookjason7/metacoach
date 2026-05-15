import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate } from 'react-router-dom'
import { API_URL } from '../config.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns the Monday of the current week as YYYY-MM-DD (local time)
function getWeekStart() {
  const today = new Date()
  const day  = today.getDay()              // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day   // days back to Monday
  const monday = new Date(today)
  monday.setDate(today.getDate() + diff)
  return monday.toLocaleDateString('sv')   // YYYY-MM-DD
}

export function fmtWeekRange(weekStartStr) {
  const [y, m, d] = weekStartStr.slice(0, 10).split('-').map(Number)
  const monday = new Date(y, m - 1, d)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  const fmt = (dt) => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${fmt(monday)} – ${fmt(sunday)}, ${y}`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function RatingRow({ label, field, value, onChange }) {
  return (
    <div>
      <p className="text-sm font-medium text-gray-700 mb-1.5">{label}</p>
      <div className="flex gap-1.5 items-center flex-wrap">
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(field, n)}
            className={`w-11 h-11 rounded-lg text-sm font-bold border transition-colors ${
              value === n
                ? 'bg-[#E8670A] text-white border-[#E8670A]'
                : 'bg-gray-50 text-gray-500 border-gray-200 hover:border-[#E8670A] hover:text-[#E8670A]'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  )
}

function CountRow({ label, field, value, onChange }) {
  return (
    <div>
      <p className="text-sm font-medium text-gray-700 mb-1.5">{label}</p>
      <div className="flex gap-1.5 flex-wrap">
        {[0, 1, 2, 3, 4, 5, 6, 7].map(n => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(field, n)}
            className={`w-11 h-11 rounded-lg text-sm font-bold border transition-colors ${
              value === n
                ? 'bg-[#1e2a3a] text-white border-[#1e2a3a]'
                : 'bg-gray-50 text-gray-500 border-gray-200 hover:border-[#1e2a3a]'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const EMPTY = {
  current_weight:     '',
  sleep_quality:      null,
  energy:             null,
  stress:             null,
  cravings:           null,
  workouts_completed: null,
  days_food_logged:   null,
  days_hit_protein:   null,
  biggest_win:        '',
  biggest_struggle:   '',
  coach_notes:        '',
}

export default function WeeklyCheckin() {
  const { getToken } = useAuth()
  const navigate = useNavigate()

  const [weekStart]         = useState(getWeekStart)
  const [form, setForm]     = useState(EMPTY)
  const [existing, setExisting] = useState(null)   // existing row for this week, if any
  const [initLoading, setInitLoading] = useState(true)
  const [submitting, setSubmitting]   = useState(false)
  const [submitted,  setSubmitted]    = useState(false)
  const [error, setError]             = useState(null)
  const submitRef = useRef(false)   // prevent double-fire

  // Pre-fill form if client already submitted this week
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/weekly-checkins/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const all = await res.json()
        const match = all.find(c => c.week_start?.slice(0, 10) === weekStart)
        if (!cancelled && match) {
          setExisting(match)
          setForm({
            current_weight:     match.current_weight     ?? '',
            sleep_quality:      match.sleep_quality      ?? null,
            energy:             match.energy             ?? null,
            stress:             match.stress             ?? null,
            cravings:           match.cravings           ?? null,
            workouts_completed: match.workouts_completed ?? null,
            days_food_logged:   match.days_food_logged   ?? null,
            days_hit_protein:   match.days_hit_protein   ?? null,
            biggest_win:        match.biggest_win        ?? '',
            biggest_struggle:   match.biggest_struggle   ?? '',
            coach_notes:        match.coach_notes        ?? '',
          })
        }
      } catch { /* non-fatal — just start with empty form */ }
      finally { if (!cancelled) setInitLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [getToken, weekStart])

  function set(field, value) { setForm(f => ({ ...f, [field]: value })) }

  async function handleSubmit(e) {
    e.preventDefault()
    if (submitRef.current) return
    submitRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/weekly-checkins`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          week_start:         weekStart,
          current_weight:     form.current_weight !== '' ? Number(form.current_weight) : null,
          sleep_quality:      form.sleep_quality,
          energy:             form.energy,
          stress:             form.stress,
          cravings:           form.cravings,
          workouts_completed: form.workouts_completed,
          days_food_logged:   form.days_food_logged,
          days_hit_protein:   form.days_hit_protein,
          biggest_win:        form.biggest_win     || null,
          biggest_struggle:   form.biggest_struggle || null,
          coach_notes:        form.coach_notes     || null,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Submit failed. Please try again.')
      }
      setSubmitted(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
      submitRef.current = false
    }
  }

  // ── Success screen ────────────────────────────────────────────────────────────

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto py-12 px-4 text-center">
        <div className="text-5xl mb-4">🎉</div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">
          {existing ? 'Check-in updated!' : 'Check-in submitted!'}
        </h2>
        <p className="text-sm text-gray-500 mb-2">Week of {fmtWeekRange(weekStart)}</p>
        <p className="text-sm text-gray-400 mb-8">Your coach will see this shortly.</p>
        <button
          onClick={() => navigate('/dashboard')}
          className="bg-[#E8670A] text-white font-semibold px-6 py-2.5 rounded-lg hover:bg-[#c45e09] transition-colors"
        >
          Back to Dashboard
        </button>
      </div>
    )
  }

  // ── Loading ───────────────────────────────────────────────────────────────────

  if (initLoading) {
    return <div className="text-center py-12 text-sm text-gray-400">Loading…</div>
  }

  // ── Form ──────────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-lg mx-auto pb-10">

      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <button
          onClick={() => navigate('/dashboard')}
          className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors rounded-lg hover:bg-gray-100"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-xl font-bold text-gray-900">Weekly Check-In</h1>
      </div>
      <p className="text-sm text-gray-500 mb-5 ml-9">Week of {fmtWeekRange(weekStart)}</p>

      {/* Already submitted banner */}
      {existing && (
        <div className="mb-5 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-700 flex items-start gap-2">
          <span className="shrink-0 mt-0.5">✓</span>
          <span>You already submitted this week. Your answers are pre-filled — update anything and resubmit.</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">

        {/* ── Weight ── */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">
            Weight <span className="text-gray-300 font-normal normal-case">(optional)</span>
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="50" max="600" step="0.1"
              value={form.current_weight}
              onChange={e => set('current_weight', e.target.value)}
              placeholder="e.g. 185"
              className="w-28 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
            <span className="text-sm text-gray-400">lbs</span>
          </div>
        </div>

        {/* ── Ratings ── */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-5">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">
            This Week's Ratings
            <span className="ml-1 text-gray-400 font-normal normal-case">(1 = low, 5 = high)</span>
          </p>
          <RatingRow label="😴 Sleep Quality"      field="sleep_quality" value={form.sleep_quality} onChange={set} />
          <RatingRow label="⚡ Energy Level"        field="energy"        value={form.energy}        onChange={set} />
          <RatingRow label="😤 Stress Level"        field="stress"        value={form.stress}        onChange={set} />
          <RatingRow label="🍕 Hunger & Cravings"   field="cravings"      value={form.cravings}      onChange={set} />
        </div>

        {/* ── Activity counts ── */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-5">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">This Week's Activity</p>
          <CountRow label="💪 Workouts completed"     field="workouts_completed" value={form.workouts_completed} onChange={set} />
          <CountRow label="📱 Days food logged"        field="days_food_logged"   value={form.days_food_logged}   onChange={set} />
          <CountRow label="🎯 Days hit protein goal"   field="days_hit_protein"   value={form.days_hit_protein}   onChange={set} />
        </div>

        {/* ── Reflections ── */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Reflections</p>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              🏆 Biggest win this week
            </label>
            <textarea
              value={form.biggest_win}
              onChange={e => set('biggest_win', e.target.value)}
              placeholder="What went really well?"
              rows={3}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Biggest struggle this week
            </label>
            <textarea
              value={form.biggest_struggle}
              onChange={e => set('biggest_struggle', e.target.value)}
              placeholder="What was hard or off-track?"
              rows={3}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Anything your coach should know
            </label>
            <textarea
              value={form.coach_notes}
              onChange={e => set('coach_notes', e.target.value)}
              placeholder="Travel, stress, injuries, life events…"
              rows={3}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
            />
          </div>
        </div>

        {/* ── Submit ── */}
        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-[#E8670A] text-white font-bold py-3.5 rounded-xl hover:bg-[#c45e09] disabled:opacity-60 transition-colors text-sm"
        >
          {submitting
            ? 'Submitting…'
            : existing
              ? 'Update Check-In'
              : 'Submit Check-In'}
        </button>

      </form>
    </div>
  )
}
