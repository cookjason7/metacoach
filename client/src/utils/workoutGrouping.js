// Shared section/group helpers for the manual workout builder (coach/admin
// editor) and the read-only client workout view. Both derive their nested
// display structure from the same flat workout_exercises rows.

export const SECTION_PRESETS  = ['Warm-Up', 'Strength', 'Conditioning', 'Cool Down', 'Cardio', 'Mobility', 'Core']
export const DEFAULT_SECTIONS = ['Warm-Up', 'Strength', 'Conditioning', 'Cool Down']

export const GROUP_TYPE_META = {
  exercise: { label: null,       badgeCls: '',                          tintCls: '' },
  superset: { label: 'Superset', badgeCls: 'bg-blue-100 text-blue-700', tintCls: 'bg-blue-50/60 border-blue-100' },
  circuit:  { label: 'Circuit',  badgeCls: 'bg-violet-100 text-violet-700', tintCls: 'bg-violet-50/60 border-violet-100' },
}

export function groupLabelFor(type, idx) {
  if (type === 'superset') return String.fromCharCode(65 + idx) // A, B, C…
  if (type === 'circuit')  return String(idx + 1)
  return null
}

// Groups a set of exercises (already sorted by sort_order, id) into
// consecutive same-group_id blocks. Rows with no group_id are each their own
// single-exercise group.
export function buildGroups(exs) {
  const groups = []
  let current = null
  for (const ex of exs) {
    const gid = ex.group_id
    if (gid && current && current.id === gid) {
      current.exercises.push(ex)
    } else {
      current = { id: gid || `single-${ex.id}`, type: ex.group_type || 'exercise', exercises: [ex] }
      groups.push(current)
    }
  }
  return groups
}

// Orders a day's distinct section names: explicit `order` override if given,
// otherwise the four defaults followed by any other section_name values seen
// on the exercises, in first-appearance order.
export function sectionOrderFor(dayExs, explicitOrder) {
  if (explicitOrder) return explicitOrder
  const seen  = new Set(DEFAULT_SECTIONS)
  const order = [...DEFAULT_SECTIONS]
  for (const ex of dayExs) {
    const sec = ex.section_name || 'Strength'
    if (!seen.has(sec)) { seen.add(sec); order.push(sec) }
  }
  return order
}

// Builds the full { name, exercises, groups }[] structure for one day.
export function buildSections(dayExs, explicitOrder) {
  const order = sectionOrderFor(dayExs, explicitOrder)
  return order.map(name => {
    const secExs = dayExs.filter(e => (e.section_name || 'Strength') === name)
    return { name, exercises: secExs, groups: buildGroups(secExs) }
  })
}
