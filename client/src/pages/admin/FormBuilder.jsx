import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate, useParams } from 'react-router-dom'
import { API_URL } from '../../config.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const FIELD_TYPES = [
  { value: 'short_text',    label: 'Short Text' },
  { value: 'long_text',     label: 'Long Text' },
  { value: 'number',        label: 'Number' },
  { value: 'date',          label: 'Date' },
  { value: 'rating',        label: 'Rating (1–5)' },
  { value: 'yes_no',        label: 'Yes / No' },
  { value: 'single_choice', label: 'Single Choice' },
  { value: 'multi_choice',  label: 'Multiple Choice' },
]

// Type-specific placeholder examples for the Question input
const QUESTION_PLACEHOLDER = {
  short_text:    'e.g. What was your biggest win this week?',
  long_text:     'e.g. Describe how your week went overall.',
  number:        'e.g. How many hours of sleep did you get last night?',
  date:          'e.g. What date did you last weigh in?',
  rating:        'e.g. How was your energy this week?',
  yes_no:        'e.g. Did you hit your water goal every day?',
  single_choice: 'e.g. How many strength workouts did you complete?',
  multi_choice:  'e.g. Which days did you fully track your food?',
}

const STATUS_STYLES = {
  draft:     'bg-gray-100 text-gray-600',
  published: 'bg-emerald-100 text-emerald-700',
  archived:  'bg-amber-100 text-amber-700',
}

function genId() {
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

function makeField(order) {
  return {
    id:          genId(),
    type:        'short_text',
    label:       '',
    description: '',
    required:    false,
    order,
    options:     ['Option 1', 'Option 2'],
    max_chars:   null,
  }
}

// When changing answer type, keep the field but reset options as needed
function changeFieldType(field, newType) {
  const isNowChoice = newType === 'single_choice' || newType === 'multi_choice'
  const wasChoice   = field.type === 'single_choice' || field.type === 'multi_choice'

  // If switching TO a choice type, ensure there are at least 2 named options
  let options = field.options ?? []
  if (isNowChoice) {
    const nonEmpty = options.filter(o => o.trim())
    if (nonEmpty.length < 2) {
      options = wasChoice ? options : ['Option 1', 'Option 2']
      // If was choice but had <2 options, pad up
      if (wasChoice && nonEmpty.length === 0) options = ['Option 1', 'Option 2']
      if (wasChoice && nonEmpty.length === 1) options = [...nonEmpty, 'Option 2']
    }
  }

  return { ...field, type: newType, options }
}

// Validate all fields before publishing; returns array of error strings
function validateForPublish(fields) {
  const errors = []
  fields.forEach((f, idx) => {
    const num = idx + 1
    if (!f.label?.trim()) {
      errors.push(`Question ${num}: question text cannot be blank.`)
    }
    if (f.type === 'single_choice' || f.type === 'multi_choice') {
      const nonEmpty = (f.options ?? []).filter(o => o.trim())
      if (nonEmpty.length < 2) {
        errors.push(`Question ${num} (${f.label?.trim() || 'Untitled'}): needs at least 2 non-empty answer options.`)
      }
    }
    if ((f.type === 'short_text' || f.type === 'long_text') && f.max_chars !== null) {
      if (!Number.isInteger(f.max_chars) || f.max_chars < 1) {
        errors.push(`Question ${num}: max characters must be a positive number.`)
      }
    }
  })
  return errors
}

// ── Answer Choices Preview (read-only, for Rating and Yes/No) ─────────────────

function RatingPreview() {
  return (
    <div>
      <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Answer Choices</p>
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map(n => (
          <div
            key={n}
            className="w-10 h-10 rounded-lg border-2 border-gray-200 bg-gray-50 flex items-center justify-center text-sm font-bold text-gray-500 select-none"
          >
            {n}
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 mt-1.5">Client selects one number, 1 = lowest, 5 = highest.</p>
    </div>
  )
}

function YesNoPreview() {
  return (
    <div>
      <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Answer Choices</p>
      <div className="flex gap-2">
        {['Yes', 'No'].map(opt => (
          <div
            key={opt}
            className="flex-1 h-10 rounded-lg border-2 border-gray-200 bg-gray-50 flex items-center justify-center text-sm font-bold text-gray-500 select-none"
          >
            {opt}
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 mt-1.5">Client selects Yes or No.</p>
    </div>
  )
}

// ── Field editor ──────────────────────────────────────────────────────────────

function FieldEditor({ field, onChange, onDelete, onMoveUp, onMoveDown, isFirst, isLast, publishError }) {
  const [open, setOpen] = useState(!field.label)  // open by default if new

  const needsOptions  = field.type === 'single_choice' || field.type === 'multi_choice'
  const showRating    = field.type === 'rating'
  const showYesNo     = field.type === 'yes_no'
  const hasMaxChars   = field.type === 'short_text' || field.type === 'long_text'
  const hasError      = !!publishError

  function update(key, val) { onChange({ ...field, [key]: val }) }
  function handleTypeChange(newType) { onChange(changeFieldType(field, newType)) }

  // Options helpers
  function addOption()         { update('options', [...(field.options ?? []), '']) }
  function removeOption(i)     { update('options', (field.options ?? []).filter((_, idx) => idx !== i)) }
  function updateOption(i, val) {
    const opts = [...(field.options ?? [])]
    opts[i] = val
    update('options', opts)
  }
  function moveOption(i, dir) {
    const opts = [...(field.options ?? [])]
    const swap = i + dir
    if (swap < 0 || swap >= opts.length) return;
    [opts[i], opts[swap]] = [opts[swap], opts[i]]
    update('options', opts)
  }

  const typeLabel   = FIELD_TYPES.find(t => t.value === field.type)?.label ?? field.type
  const optionCount = needsOptions ? (field.options ?? []).filter(o => o.trim()).length : 0

  // Collapsed card badge: show choices hint per type
  function choiceBadge() {
    if (field.type === 'rating')        return <span className="text-[10px] text-gray-400">1–5</span>
    if (field.type === 'yes_no')        return <span className="text-[10px] text-gray-400">Yes / No</span>
    if (needsOptions && optionCount > 0) return <span className="text-[10px] text-gray-400">{optionCount} option{optionCount !== 1 ? 's' : ''}</span>
    if (needsOptions && optionCount === 0) return <span className="text-[10px] text-red-400 font-medium">No options yet</span>
    return null
  }

  return (
    <div className={`bg-white border rounded-xl overflow-hidden transition-colors ${
      hasError ? 'border-red-300' : open ? 'border-[#E8670A]' : 'border-gray-200'
    }`}>
      {/* ── Collapsed summary row ── */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        {/* Reorder arrows */}
        <div className="flex flex-col gap-0.5 shrink-0">
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onMoveUp() }}
            disabled={isFirst}
            className="w-5 h-5 flex items-center justify-center text-gray-300 hover:text-gray-500 disabled:opacity-20 rounded"
            aria-label="Move up"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onMoveDown() }}
            disabled={isLast}
            className="w-5 h-5 flex items-center justify-center text-gray-300 hover:text-gray-500 disabled:opacity-20 rounded"
            aria-label="Move down"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {/* Label + meta */}
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium truncate ${field.label ? 'text-gray-900' : 'text-gray-400 italic'}`}>
            {field.label || 'Untitled question'}
          </p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-[10px] text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 font-medium">{typeLabel}</span>
            {field.required && (
              <span className="text-[10px] text-[#E8670A] font-bold uppercase tracking-wide">Required</span>
            )}
            {choiceBadge()}
            {hasError && (
              <span className="text-[10px] text-red-500 font-semibold">⚠ Needs attention</span>
            )}
          </div>
        </div>

        {/* Delete + chevron */}
        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            onClick={onDelete}
            className="text-red-400 hover:text-red-600 text-xs font-medium px-2 py-1.5 rounded hover:bg-red-50 transition-colors"
          >
            Delete
          </button>
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* ── Expanded editor ── */}
      {open && (
        <div className="px-4 pb-5 border-t border-gray-100 pt-4 space-y-4">

          {/* Row 1: Answer Type + Required toggle */}
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">
                Answer Type
              </label>
              <select
                value={field.type}
                onChange={e => handleTypeChange(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              >
                {FIELD_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="pb-1">
              <button
                type="button"
                onClick={() => update('required', !field.required)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  field.required
                    ? 'bg-[#E8670A]/10 border-[#E8670A]/30 text-[#E8670A]'
                    : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                }`}
              >
                <span className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                  field.required ? 'bg-[#E8670A] border-[#E8670A]' : 'border-gray-300'
                }`}>
                  {field.required && (
                    <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                Required
              </button>
            </div>
          </div>

          {/* Question */}
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">
              Question <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={field.label}
              onChange={e => update('label', e.target.value)}
              placeholder={QUESTION_PLACEHOLDER[field.type] ?? 'Enter your question'}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] transition-colors ${
                !field.label.trim() && hasError ? 'border-red-300 bg-red-50' : 'border-gray-200'
              }`}
            />
          </div>

          {/* Helper text */}
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">
              Helper Text <span className="text-gray-300 font-normal normal-case">(optional)</span>
            </label>
            <input
              type="text"
              value={field.description}
              onChange={e => update('description', e.target.value)}
              placeholder="Short hint or instruction shown below the question"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>

          {/* Max characters (short/long text only) */}
          {hasMaxChars && (
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">
                Max Characters <span className="text-gray-300 font-normal normal-case">(optional)</span>
              </label>
              <input
                type="number"
                min="1"
                max="10000"
                value={field.max_chars ?? ''}
                onChange={e => update('max_chars', e.target.value ? Number(e.target.value) : null)}
                placeholder="No limit"
                className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </div>
          )}

          {/* ── Answer Choices: Rating preview ── */}
          {showRating && (
            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <RatingPreview />
            </div>
          )}

          {/* ── Answer Choices: Yes/No preview ── */}
          {showYesNo && (
            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <YesNoPreview />
            </div>
          )}

          {/* ── Answer Choices: editable options for choice fields ── */}
          {needsOptions && (
            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                  Answer Options <span className="text-red-400">*</span>
                </p>
                <span className="text-[10px] text-gray-400">Min. 2 required to publish</span>
              </div>

              {/* Validation hint */}
              {hasError && (field.options ?? []).filter(o => o.trim()).length < 2 && (
                <p className="text-xs text-red-500 font-medium">Add at least 2 non-empty options.</p>
              )}

              <div className="space-y-2">
                {(field.options ?? []).map((opt, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    {/* Up/down for options */}
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => moveOption(i, -1)}
                        disabled={i === 0}
                        className="w-4 h-4 flex items-center justify-center text-gray-300 hover:text-gray-500 disabled:opacity-20"
                        aria-label="Move option up"
                      >
                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => moveOption(i, 1)}
                        disabled={i === (field.options?.length ?? 1) - 1}
                        className="w-4 h-4 flex items-center justify-center text-gray-300 hover:text-gray-500 disabled:opacity-20"
                        aria-label="Move option down"
                      >
                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                    </div>

                    {/* Number pill */}
                    <span className="text-[10px] font-bold text-gray-400 w-5 text-center shrink-0">{i + 1}</span>

                    <input
                      type="text"
                      value={opt}
                      onChange={e => updateOption(i, e.target.value)}
                      placeholder={`Option ${i + 1}`}
                      className={`flex-1 border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A] transition-colors ${
                        hasError && !opt.trim() ? 'border-red-200' : 'border-gray-200'
                      }`}
                    />

                    <button
                      type="button"
                      onClick={() => removeOption(i)}
                      disabled={(field.options?.length ?? 0) <= 1}
                      className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-100 rounded-lg transition-colors disabled:opacity-20 shrink-0"
                      aria-label="Remove option"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={addOption}
                className="flex items-center gap-1.5 text-xs text-[#E8670A] font-semibold hover:underline"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Add Option
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function FormBuilder() {
  const { getToken }    = useAuth()
  const navigate        = useNavigate()
  const { id: paramId } = useParams()

  const [template,      setTemplate]      = useState(null)
  const [title,         setTitle]         = useState('')
  const [desc,          setDesc]          = useState('')
  const [fields,        setFields]        = useState([])
  const [loading,       setLoading]       = useState(!!paramId)
  const [saving,        setSaving]        = useState(false)
  const [publishing,    setPublishing]    = useState(false)
  const [saveMsg,       setSaveMsg]       = useState('')
  const [error,         setError]         = useState(null)
  const [publishErrors, setPublishErrors] = useState([])
  const saveTimer = useRef(null)

  // Load existing form
  useEffect(() => {
    if (!paramId) return
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/forms/${paramId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`Server ${res.status}`)
        const data = await res.json()
        setTemplate(data)
        setTitle(data.title ?? '')
        setDesc(data.description ?? '')
        setFields(Array.isArray(data.draft_schema) ? data.draft_schema : [])
      } catch (e) { setError(e.message) }
      finally { setLoading(false) }
    }
    load()
  }, [paramId, getToken])

  // Save helper
  const saveNow = useCallback(async (newTitle, newDesc, newFields, quiet = false) => {
    if (!paramId) return
    if (!quiet) setSaving(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/forms/${paramId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:        newTitle,
          description:  newDesc || null,
          draft_schema: newFields,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      const updated = await res.json()
      setTemplate(updated)
      setSaveMsg('Saved')
      setTimeout(() => setSaveMsg(''), 2000)
    } catch { setSaveMsg('Save failed') }
    finally { if (!quiet) setSaving(false) }
  }, [paramId, getToken])

  // Debounced auto-save
  function triggerAutoSave(t, d, f) {
    if (!paramId) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => saveNow(t, d, f, true), 1200)
  }

  function updateTitle(v)  { setTitle(v);  triggerAutoSave(v, desc, fields) }
  function updateDesc(v)   { setDesc(v);   triggerAutoSave(title, v, fields) }
  function updateFields(f) { setFields(f); triggerAutoSave(title, desc, f) }

  function addField() {
    updateFields([...fields, makeField(fields.length)])
  }
  function updateField(idx, updated) {
    const next = fields.map((f, i) => i === idx ? { ...updated, order: i } : f)
    updateFields(next)
    if (publishErrors.length > 0) setPublishErrors([])
    if (error) setError(null)
  }
  function deleteField(idx) {
    updateFields(fields.filter((_, i) => i !== idx).map((f, i) => ({ ...f, order: i })))
  }
  function moveField(idx, dir) {
    const next = [...fields]
    const swap = idx + dir
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]]
    updateFields(next.map((f, i) => ({ ...f, order: i })))
  }

  async function handleManualSave() {
    clearTimeout(saveTimer.current)
    await saveNow(title, desc, fields)
  }

  async function handlePublish() {
    setPublishErrors([])
    setError(null)

    if (!title.trim()) {
      setError('Form title is required before publishing.')
      return
    }
    if (fields.length === 0) {
      setError('Add at least one question before publishing.')
      return
    }
    const valErrors = validateForPublish(fields)
    if (valErrors.length > 0) {
      setPublishErrors(valErrors)
      setError('Please fix the issues below before publishing.')
      return
    }

    clearTimeout(saveTimer.current)
    await saveNow(title, desc, fields, true)
    setPublishing(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/forms/${paramId}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Publish failed')
      setTemplate(data.template)
      setSaveMsg('Published!')
      setTimeout(() => setSaveMsg(''), 3000)
    } catch (e) { setError(e.message) }
    finally { setPublishing(false) }
  }

  function fieldHasPublishError(idx) {
    if (!publishErrors.length) return false
    return publishErrors.some(e => e.startsWith(`Question ${idx + 1}:`))
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) {
    return <p className="text-center text-gray-400 py-12 text-sm">Loading form…</p>
  }

  const status     = template?.status ?? 'draft'
  const isArchived = status === 'archived'

  return (
    <div className="max-w-2xl mx-auto pb-10">

      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={() => navigate('/admin/forms')}
          className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900 truncate">{title || 'Untitled Form'}</h1>
        </div>
        <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full ${STATUS_STYLES[status] ?? STATUS_STYLES.draft}`}>
          {status}
        </span>
        {saveMsg && <span className="text-xs text-gray-400">{saveMsg}</span>}
      </div>

      {/* Global error banner */}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          <p className="font-semibold mb-1">{error}</p>
          {publishErrors.length > 0 && (
            <ul className="list-disc list-inside space-y-0.5 text-red-600">
              {publishErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}

      {isArchived && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
          This form is archived. It can be viewed but not edited or published.
        </div>
      )}

      {/* Form metadata */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3 mb-4">
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Form Title *</label>
          <input
            type="text"
            value={title}
            onChange={e => updateTitle(e.target.value)}
            disabled={isArchived}
            placeholder="e.g. Weekly Check-In"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] disabled:bg-gray-50 disabled:text-gray-400"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">
            Description <span className="text-gray-300 font-normal normal-case">(shown to client)</span>
          </label>
          <textarea
            value={desc}
            onChange={e => updateDesc(e.target.value)}
            disabled={isArchived}
            placeholder="Optional intro or instructions for the client"
            rows={2}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none disabled:bg-gray-50"
          />
        </div>
      </div>

      {/* Fields */}
      <div className="space-y-3 mb-4">
        {fields.length === 0 ? (
          <div className="bg-gray-50 border border-dashed border-gray-200 rounded-xl p-8 text-center">
            <p className="text-sm text-gray-400 mb-1">No questions yet.</p>
            <p className="text-xs text-gray-300">Click "Add Question" below to get started.</p>
          </div>
        ) : (
          fields.map((field, idx) => (
            <FieldEditor
              key={field.id}
              field={field}
              onChange={updated => updateField(idx, updated)}
              onDelete={() => deleteField(idx)}
              onMoveUp={() => moveField(idx, -1)}
              onMoveDown={() => moveField(idx, 1)}
              isFirst={idx === 0}
              isLast={idx === fields.length - 1}
              publishError={fieldHasPublishError(idx)}
            />
          ))
        )}
      </div>

      {/* Add question */}
      {!isArchived && (
        <button
          type="button"
          onClick={addField}
          className="w-full flex items-center justify-center gap-2 border border-dashed border-gray-300 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A] font-semibold py-3 rounded-xl text-sm transition-colors mb-6"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add Question
        </button>
      )}

      {/* Action buttons */}
      {!isArchived && paramId && (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleManualSave}
            disabled={saving}
            className="flex-1 border border-gray-200 text-gray-700 font-semibold py-3 rounded-xl text-sm hover:bg-gray-50 disabled:opacity-60 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Draft'}
          </button>
          <button
            type="button"
            onClick={handlePublish}
            disabled={publishing}
            className="flex-1 bg-[#E8670A] text-white font-bold py-3 rounded-xl text-sm hover:bg-[#c45e09] disabled:opacity-60 transition-colors"
          >
            {publishing
              ? 'Publishing…'
              : status === 'published'
                ? 'Republish (new version)'
                : 'Publish Form'}
          </button>
        </div>
      )}

      {/* Preview link */}
      {status === 'published' && (
        <div className="mt-4 text-center">
          <button
            onClick={() => navigate(`/forms/${paramId}/fill?preview=1`)}
            className="text-sm text-blue-600 hover:underline font-medium"
          >
            Preview as client →
          </button>
        </div>
      )}
    </div>
  )
}
