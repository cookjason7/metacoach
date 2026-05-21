import { useState, useEffect } from 'react'

const CONDITIONS = [
  { value: 'type1_diabetes',                   label: 'Type 1 Diabetes' },
  { value: 'type2_diabetes_prediabetes',        label: 'Type 2 Diabetes or Prediabetes' },
  { value: 'thyroid_condition',                 label: 'Thyroid condition (not medicated)' },
  { value: 'taking_thyroid_medication',         label: 'Taking thyroid medication' },
  { value: 'testosterone_trt_hormone_therapy',  label: 'Testosterone / TRT or hormone therapy' },
  { value: 'kidney_disease',                   label: 'Kidney disease' },
  { value: 'autoimmune_condition',              label: 'Autoimmune condition' },
  { value: 'none',                             label: 'None of the above' },
]

const MEDICATION_CATEGORIES = [
  { value: 'hormones',        label: 'Hormones' },
  { value: 'blood_pressure',  label: 'Blood pressure' },
  { value: 'cholesterol',     label: 'Cholesterol' },
  { value: 'diabetes',        label: 'Diabetes medications' },
  { value: 'thyroid',         label: 'Thyroid medications' },
  { value: 'steroids',        label: 'Steroids (prescription)' },
  { value: 'antidepressants', label: 'Antidepressants or mood stabilizers' },
  { value: 'other',           label: 'Other prescription medications' },
  { value: 'none',            label: 'None' },
]

const SEX_OPTIONS = ['Male', 'Female', 'Intersex / Other', 'Prefer not to say']

function emptyForm(defaults = {}) {
  const totalInches = defaults.height_inches ? Number(defaults.height_inches) : null
  return {
    conditions:             [],
    medication_categories:  [],
    confirmed_age:          defaults.age          ? String(defaults.age)          : '',
    confirmed_sex:          defaults.sex          ?? '',
    height_ft:              totalInches           ? String(Math.floor(totalInches / 12)) : '',
    height_in:              totalInches           ? String(Math.round(totalInches % 12)) : '',
    confirmed_weight_lbs:   defaults.weight_lbs   ? String(defaults.weight_lbs)   : '',
    notes:                  '',
  }
}

function intakeToForm(intake) {
  const h = intake.confirmed_height_inches ? Number(intake.confirmed_height_inches) : null
  return {
    conditions:            Array.isArray(intake.conditions)            ? intake.conditions            : [],
    medication_categories: Array.isArray(intake.medication_categories) ? intake.medication_categories : [],
    confirmed_age:         intake.confirmed_age          != null ? String(intake.confirmed_age)         : '',
    confirmed_sex:         intake.confirmed_sex          ?? '',
    height_ft:             h                             != null ? String(Math.floor(h / 12))           : '',
    height_in:             h                             != null ? String(Math.round(h % 12))           : '',
    confirmed_weight_lbs:  intake.confirmed_weight_lbs   != null ? String(intake.confirmed_weight_lbs) : '',
    notes:                 intake.notes                  ?? '',
  }
}

function formToPayload(form) {
  const ft  = parseInt(form.height_ft,  10)
  const ins = parseInt(form.height_in,  10)
  const totalIn = (!isNaN(ft) && !isNaN(ins)) ? ft * 12 + ins : null
  return {
    conditions:             form.conditions,
    medication_categories:  form.medication_categories,
    confirmed_age:          parseInt(form.confirmed_age, 10)      || null,
    confirmed_sex:          form.confirmed_sex || null,
    confirmed_height_inches: totalIn,
    confirmed_weight_lbs:   parseFloat(form.confirmed_weight_lbs) || null,
    notes:                  form.notes.trim() || null,
  }
}

function fmtDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function toggleExclusive(list, value, noneValue = 'none') {
  if (value === noneValue) {
    return list.includes(noneValue) ? [] : [noneValue]
  }
  const without = list.filter(v => v !== noneValue && v !== value)
  return list.includes(value) ? without : [...without, value]
}

export default function BloodworkIntakeForm({ intakeUrl, getToken, defaults = {}, onIntakeChange }) {
  const [intake, setIntake]   = useState(undefined) // undefined = loading, null = not saved
  const [form, setForm]       = useState(emptyForm(defaults))
  const [open, setOpen]       = useState(false)
  const [saving, setSaving]   = useState(false)
  const [saveError, setSaveError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(intakeUrl, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(`Server ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        if (data) {
          setIntake(data)
          setForm(intakeToForm(data))
          setOpen(false)
          onIntakeChange?.(data)
        } else {
          setIntake(null)
          setForm(emptyForm(defaults))
          setOpen(true)
          onIntakeChange?.(null)
        }
      } catch {
        if (!cancelled) { setIntake(null); setOpen(true) }
      }
    }
    load()
    return () => { cancelled = true }
  }, [intakeUrl, getToken]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)
    try {
      const token = await getToken()
      const res = await fetch(intakeUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(formToPayload(form)),
      })
      const data = await res.json()
      if (!res.ok) { setSaveError(data.error ?? 'Save failed.'); return }
      setIntake(data)
      setForm(intakeToForm(data))
      setOpen(false)
      onIntakeChange?.(data)
    } catch { setSaveError('Save failed. Please try again.') }
    finally { setSaving(false) }
  }

  const hasSaved = intake != null

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <span className="text-base">🧬</span>
          <div>
            <p className="text-sm font-semibold text-gray-800">Health Context for Lab Interpretation</p>
            {hasSaved ? (
              <p className="text-xs text-emerald-600 mt-0.5">
                Saved {intake.updated_at ? fmtDate(intake.updated_at) : ''} · Tap to edit
              </p>
            ) : (
              <p className="text-xs text-amber-600 mt-0.5">Not filled in yet — AI analysis will be less precise</p>
            )}
          </div>
        </div>
        <span className="text-gray-400 text-sm shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <form onSubmit={handleSave} className="border-t border-gray-100 px-5 pb-5 pt-4 space-y-5">

          {/* 1. Conditions */}
          <fieldset>
            <legend className="text-xs font-semibold text-gray-700 mb-2">
              1. Conditions — check all that apply
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {CONDITIONS.map(c => (
                <label key={c.value} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={form.conditions.includes(c.value)}
                    onChange={() => setForm(f => ({ ...f, conditions: toggleExclusive(f.conditions, c.value) }))}
                    className="w-4 h-4 rounded border-gray-300 text-[#E8670A] focus:ring-[#E8670A]/30"
                  />
                  <span className="text-xs text-gray-700 group-hover:text-gray-900 leading-snug">{c.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* 2. Medication categories */}
          <fieldset>
            <legend className="text-xs font-semibold text-gray-700 mb-2">
              2. Prescription medication categories — check all that apply
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {MEDICATION_CATEGORIES.map(m => (
                <label key={m.value} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={form.medication_categories.includes(m.value)}
                    onChange={() => setForm(f => ({ ...f, medication_categories: toggleExclusive(f.medication_categories, m.value) }))}
                    className="w-4 h-4 rounded border-gray-300 text-[#E8670A] focus:ring-[#E8670A]/30"
                  />
                  <span className="text-xs text-gray-700 group-hover:text-gray-900 leading-snug">{m.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* 3. Confirm demographic fields */}
          <div>
            <p className="text-xs font-semibold text-gray-700 mb-2">3. Confirm your information</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">Age</label>
                <input
                  type="number"
                  min="1"
                  max="120"
                  placeholder="e.g. 42"
                  value={form.confirmed_age}
                  onChange={e => setForm(f => ({ ...f, confirmed_age: e.target.value }))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
                />
              </div>

              <div className="col-span-2 sm:col-span-1">
                <label className="block text-[11px] font-medium text-gray-500 mb-1">Biological sex</label>
                <select
                  value={form.confirmed_sex}
                  onChange={e => setForm(f => ({ ...f, confirmed_sex: e.target.value }))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A] bg-white"
                >
                  <option value="">Select…</option>
                  {SEX_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              <div className="col-span-2">
                <label className="block text-[11px] font-medium text-gray-500 mb-1">Height</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    max="8"
                    placeholder="ft"
                    value={form.height_ft}
                    onChange={e => setForm(f => ({ ...f, height_ft: e.target.value }))}
                    className="w-16 text-sm border border-gray-200 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
                  />
                  <span className="text-xs text-gray-400">ft</span>
                  <input
                    type="number"
                    min="0"
                    max="11"
                    placeholder="in"
                    value={form.height_in}
                    onChange={e => setForm(f => ({ ...f, height_in: e.target.value }))}
                    className="w-16 text-sm border border-gray-200 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
                  />
                  <span className="text-xs text-gray-400">in</span>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">Weight (lbs)</label>
                <input
                  type="number"
                  min="50"
                  max="700"
                  step="0.1"
                  placeholder="lbs"
                  value={form.confirmed_weight_lbs}
                  onChange={e => setForm(f => ({ ...f, confirmed_weight_lbs: e.target.value }))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
                />
              </div>
            </div>
          </div>

          {/* 4. Optional notes */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              4. Anything else the coach or provider should know?{' '}
              <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="e.g. post-surgery recovery, recent illness, fasting status, specific symptoms…"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
            />
          </div>

          {saveError && <p className="text-xs text-red-500">{saveError}</p>}

          <button
            type="submit"
            disabled={saving}
            className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#1e2a3a] text-white hover:bg-[#243347] transition-colors disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save Health Context'}
          </button>
        </form>
      )}
    </div>
  )
}
