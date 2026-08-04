// Shared progress chart primitives — originally lived only in client/src/pages/Progress.jsx
// and were independently re-implemented (and drifted) in admin/ClientProfile.jsx as
// MiniChart/ChartCard. Consolidated here so both sides render identically. The optional
// data2/color2 dual-series overlay (dashed second line) was ported in from the admin
// version's MiniChart — the client side never used it before this consolidation.

function localIso(d = new Date()) {
  const y   = d.getFullYear()
  const m   = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtNum(v, dec = 0) {
  if (v == null) return null
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: dec })
}

function fmtDayLabel(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`)
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()}`
}

// Builds one entry per calendar day between startIso/endIso (inclusive), filling
// in `value: null` for days with no logged entry — this is what lets the chart
// gap missing days instead of interpolating through them. Only meaningful at
// day-level granularity; callers with week/month-bucketed data should pass
// `dense={false}` to ChartCard instead of relying on this.
function buildDenseSeries(sparseData, startIso, endIso) {
  const byDate = new Map()
  ;(sparseData ?? []).forEach(d => {
    if (d.value == null) return
    byDate.set(String(d.date).slice(0, 10), Number(d.value))
  })
  const days = []
  if (!startIso || !endIso) return days
  const cur = new Date(`${startIso}T12:00:00`)
  const end = new Date(`${endIso}T12:00:00`)
  while (cur <= end) {
    const iso = localIso(cur)
    days.push({ date: iso, value: byDate.has(iso) ? byDate.get(iso) : null })
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

// pg returns date columns as JS Date objects, not plain strings — String(Date)
// gives "Mon Aug 04 2026 …", so slicing it produces garbage. Normalize to ISO.
function dateKey(d) {
  const raw = d?.date
  if (raw instanceof Date) return localIso(raw)
  return String(raw ?? '').slice(0, 10)
}

function cleanSort(arr) {
  return (arr ?? [])
    .filter(d => d.value != null && Number.isFinite(Number(d.value)))
    // Use timestamp arithmetic — pg returns date columns as JS Date objects,
    // not plain strings, so String().localeCompare() gives wrong ordering.
    .sort((a, b) => new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime())
}

// Projects two series onto one shared, ordered date domain (the union of the
// dates present in either), filling `value: null` where a series has no entry
// for that date. Non-dense (week/month-bucketed) callers need this: filtering
// each series independently and then spreading each across the full chart width
// by its own point count put bucket i of data2 at a different X than bucket i of
// data whenever one series had a null the other didn't. A missing value now
// leaves a gap at that date's position instead of compressing the array.
function alignSeries(a, b) {
  const dates = new Set()
  const clean = arr => cleanSort(arr).map(d => [dateKey(d), Number(d.value)])
  const ca = clean(a), cb = clean(b)
  ca.forEach(([iso]) => dates.add(iso))
  cb.forEach(([iso]) => dates.add(iso))
  const domain = [...dates].sort((x, y) => x.localeCompare(y))
  const project = pairs => {
    const byDate = new Map(pairs)
    return domain.map(iso => ({ date: iso, value: byDate.has(iso) ? byDate.get(iso) : null }))
  }
  return [project(ca), project(cb)]
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
// `data` is a dense, one-entry-per-day array (see buildDenseSeries) — days with
// no logged value carry value: null, which breaks the line instead of joining
// across the gap. `data2`/`color2` draw an optional dashed overlay series (e.g.
// protein over a calories primary line). `data2` is expected to be aligned to
// `data` — same length, same date at each index, `value: null` for gaps — so
// both series share one x-scale (ChartCard guarantees this via buildDenseSeries
// or alignSeries). A mismatched length falls back to independent scaling.

export function Sparkline({ data, goalValue, color = '#E8670A', data2, color2 = '#10b981' }) {
  if (!data || data.length < 2) return null
  const nonNull = data.filter(d => d.value != null).map(d => Number(d.value))
  if (nonNull.length === 0) return null
  const nonNull2 = (data2 ?? []).filter(d => d.value != null).map(d => Number(d.value))
  const allVals = [
    ...nonNull,
    ...nonNull2,
    ...(goalValue != null ? [Number(goalValue)] : []),
  ]
  const minV = Math.min(...allVals), maxV = Math.max(...allVals)
  const span = maxV - minV || 1
  const W = 400, H = 72, PX = 6, PY = 6
  const scaleX = n => i => PX + (n === 1 ? 0 : (i / (n - 1)) * (W - PX * 2))
  const ys = v => H - PY - ((Number(v) - minV) / span) * (H - PY * 2)

  const n  = data.length
  const xs = scaleX(n)

  // Group into runs of consecutive logged days so the line breaks at gaps.
  function buildRuns(series) {
    const runs = []
    let run = []
    series.forEach((d, i) => {
      if (d.value != null) {
        run.push(i)
      } else if (run.length) {
        runs.push(run); run = []
      }
    })
    if (run.length) runs.push(run)
    return runs
  }
  const runs = buildRuns(data)
  let lastIdx = null
  for (let i = n - 1; i >= 0; i--) { if (data[i].value != null) { lastIdx = i; break } }

  const n2    = data2?.length ?? 0
  const xs2   = n2 === n ? xs : scaleX(n2)
  const runs2 = data2 && n2 >= 1 ? buildRuns(data2) : []

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" aria-hidden="true">
      {goalValue != null && (
        <line x1={PX} y1={ys(goalValue)} x2={W - PX} y2={ys(goalValue)}
          stroke="#d1d5db" strokeWidth="1.5" strokeDasharray="5 3" />
      )}
      {runs.map((idxs, ri) => {
        if (idxs.length === 1) {
          const i = idxs[0]
          return <circle key={ri} cx={xs(i)} cy={ys(data[i].value)} r="3" fill={color} />
        }
        const pts  = idxs.map(i => `${xs(i)},${ys(data[i].value)}`).join(' ')
        const fill = `M${xs(idxs[0])},${ys(data[idxs[0]].value)} ` +
          idxs.slice(1).map(i => `L${xs(i)},${ys(data[i].value)}`).join(' ') +
          ` L${xs(idxs[idxs.length - 1])},${H} L${xs(idxs[0])},${H} Z`
        return (
          <g key={ri}>
            <path d={fill} fill={color} fillOpacity="0.08" />
            <polyline fill="none" stroke={color} strokeWidth="2.5"
              strokeLinejoin="round" strokeLinecap="round" points={pts} />
          </g>
        )
      })}
      {runs2.map((idxs, ri) => {
        // Isolated points can't form a polyline — mark them the same way the
        // primary series does, so single-day overlay values stay visible.
        if (idxs.length === 1) {
          const i = idxs[0]
          return <circle key={`s2-${ri}`} cx={xs2(i)} cy={ys(data2[i].value)} r="3" fill={color2} />
        }
        const pts = idxs.map(i => `${xs2(i)},${ys(data2[i].value)}`).join(' ')
        return (
          <polyline key={`s2-${ri}`} fill="none" stroke={color2} strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" strokeDasharray="5 3" points={pts} />
        )
      })}
      {lastIdx != null && (
        <circle cx={xs(lastIdx)} cy={ys(data[lastIdx].value)} r="4" fill={color} />
      )}
    </svg>
  )
}

// ── X-axis date labels ────────────────────────────────────────────────────────
// Shows a capped number of evenly-spaced date labels beneath the chart so
// density stays readable on mobile even at 30/90-day ranges.

export function AxisLabels({ data }) {
  const n = data?.length ?? 0
  if (n < 2) return null
  const desired = Math.min(n, 6)
  const step    = Math.max(1, Math.round((n - 1) / (desired - 1)))
  const idxs    = []
  for (let i = 0; i < n; i += step) idxs.push(i)
  if (idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1)
  return (
    <div className="relative h-3.5 mt-1 text-[9px] text-gray-400 select-none">
      {idxs.map(i => {
        const align = i === 0 ? 'left' : i === n - 1 ? 'right' : 'center'
        const left  = n === 1 ? 50 : (i / (n - 1)) * 100
        return (
          <span key={i} className="absolute whitespace-nowrap"
            style={{
              left: `${left}%`,
              transform: align === 'left' ? 'translateX(0)' : align === 'right' ? 'translateX(-100%)' : 'translateX(-50%)',
            }}>
            {fmtDayLabel(data[i].date)}
          </span>
        )
      })}
    </div>
  )
}

// ── Missing entries strip ─────────────────────────────────────────────────────
// Client-only affordance — coaches don't get a "log this for the client" CTA, so
// admin callers simply omit `quickLogMetric`.

export function MissingEntriesStrip({ missingDates, onLogDate }) {
  if (!missingDates.length) return null
  const CAP   = 6
  const shown = missingDates.slice(0, CAP)
  const extra = missingDates.length - shown.length
  return (
    <div className="bg-amber-50 border border-amber-100 rounded-2xl p-3 mb-4">
      <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide mb-2">
        Missing {missingDates.length} {missingDates.length === 1 ? 'day' : 'days'}
      </p>
      <div className="flex flex-wrap gap-2">
        {shown.map(iso => (
          <button key={iso} type="button" onClick={() => onLogDate(iso)}
            className="min-h-[44px] px-3 rounded-full bg-white border border-amber-200 text-xs font-medium text-amber-800 hover:bg-amber-100 active:bg-amber-200 transition-colors">
            {fmtDayLabel(iso)}
          </button>
        ))}
        {extra > 0 && (
          <span className="min-h-[44px] px-3 inline-flex items-center text-xs font-medium text-amber-600">
            +{extra} more
          </span>
        )}
      </div>
    </div>
  )
}

// ── ChartCard — generic card used by both the client Progress page and the
// admin/coach ClientProfile progress tab ──────────────────────────────────────
//
// `data`/`data2` are `{ date, value }` arrays (pre-mapped by the caller — e.g.
// macro_series.map(d => ({ date: d.date, value: d.calories }))).
//
// `dense` (default true) controls whether the chart fills in one entry per
// calendar day (gap-breaking the line on unlogged days) — this only makes
// sense for day-level data. Callers rendering week/month-bucketed series
// (e.g. admin's weekly/monthly range views) should pass `dense={false}` to
// fall back to a plain connected line through the actual data points.

export function ChartCard({
  title, data, data2, goalValue, goalLabel, fmtVal,
  rangeStart, rangeEnd, quickLogMetric, dense = true,
  color, color2, legend, className = '',
}) {
  const cleanData = cleanSort(data)
  const values    = cleanData.map(d => Number(d.value))
  const hasData   = values.length >= 2

  // Both series must share one X domain or the overlay drifts horizontally.
  // Dense mode gets that for free (every day between rangeStart/rangeEnd);
  // non-dense mode has to derive it from the union of both series' dates.
  let chartData, chartData2 = null
  if (dense) {
    chartData  = buildDenseSeries(data, rangeStart, rangeEnd)
    chartData2 = data2 ? buildDenseSeries(data2, rangeStart, rangeEnd) : null
  } else if (data2) {
    ;[chartData, chartData2] = alignSeries(data, data2)
  } else {
    chartData = cleanData
  }

  const missingDates = (quickLogMetric && dense)
    ? chartData.filter(d => d.value == null).map(d => d.date)
    : []

  function onLogDate(iso) {
    window.dispatchEvent(new CustomEvent('open-quick-log', { detail: { action: quickLogMetric, date: iso } }))
  }

  return (
    <div className={`bg-white rounded-2xl border border-gray-200 p-4 mb-4 ${className}`}>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        {legend && <div className="flex items-center gap-3 text-[10px] text-gray-400">{legend}</div>}
        {goalValue != null && (
          <span className="text-xs text-gray-400">Goal: {goalLabel ?? fmtNum(goalValue)}</span>
        )}
      </div>
      {hasData ? (
        <>
          {!data2 && (
            <div className="flex justify-between text-[10px] text-gray-400 mb-0.5">
              <span>{fmtVal ? fmtVal(Math.min(...values)) : fmtNum(Math.min(...values))}</span>
              <span>{fmtVal ? fmtVal(Math.max(...values)) : fmtNum(Math.max(...values))}</span>
            </div>
          )}
          <Sparkline data={chartData} data2={chartData2} goalValue={goalValue} color={color} color2={color2} />
          <AxisLabels data={chartData} />
        </>
      ) : (
        <p className="text-xs text-gray-400 text-center py-5">Not enough data to chart yet.</p>
      )}
      {quickLogMetric && dense && (
        <div className="mt-3">
          <MissingEntriesStrip missingDates={missingDates} onLogDate={onLogDate} />
        </div>
      )}
    </div>
  )
}
