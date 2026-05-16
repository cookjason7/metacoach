import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { API_URL } from '../config.js'

// ── Field renderers ───────────────────────────────────────────────────────────

function RatingField({ field, value, onChange, disabled }) {
  return (
    <div className="flex gap-2 flex-wrap">
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          onClick={() => !disabled && onChange(n)}
          className={`w-11 h-11 rounded-xl text-sm font-bold border-2 transition-all ${
            disabled ? 'cursor-default opacity-70' : ''
          } ${
            value === n
              ? 'bg-[#E8670A] border-[#E8670A] text-white shadow-sm'
              : 'bg-white border-gray-200 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A]'
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  )
}

function YesNoField({ value, onChange, disabled }) {
  return (
    <div className="flex gap-3">
      {['Yes', 'No'].map(opt => (
        <button
          key={opt}
          type="button"
          onClick={() => !disabled && onChange(opt)}
          className={`flex-1 h-11 rounded-xl text-sm font-bold border-2 transition-all ${
            disabled ? 'cursor-default opacity-70' : ''
          } ${
            value === opt
              ? 'bg-[#E8670A] border-[#E8670A] text-white'
              : 'bg-white border-gray-200 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A]'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

function SingleChoiceField({ field, value, onChange, disabled }) {
  const options = field.options ?? []
  return (
    <div className="space-y-2">
      {options.map(opt => {
        const selected = value === opt
        return (
          <button
            key={opt}
            type="button"
            onClick={() => !disabled && onChange(opt)}
            className={`w-full text-left flex items-center gap-3 px-4 rounded-xl text-sm font-medium border-2 transition-all min-h-[44px] ${
              disabled ? 'cursor-default opacity-70' : ''
            } ${
              selected
                ? 'bg-[#E8670A] border-[#E8670A] text-white'
                : 'bg-white border-gray-200 text-gray-700 hover:border-[#E8670A]/50'
            }`}
          >
            <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
              selected ? 'border-white' : 'border-gray-300'
            }`}>
              {selected && <span className="w-2 h-2 rounded-full bg-white block" />}
            </span>
            {opt}
          </button>
        )
      })}
    </div>
  )
}

function MultiChoiceField({ field, value, onChange, disabled }) {
  const options = field.options ?? []
  const selected = Array.isArray(value) ? value : []

  function toggle(opt) {
    if (disabled) return
    if (selected.includes(opt)) onChange(selected.filter(o => o !== opt))
    else onChange([...selected, opt])
  }

  return (
    <div className="space-y-2">
      {options.map(opt => {
        const active = selected.includes(opt)
        return (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className={`w-full text-left flex items-center gap-3 px-4 rounded-xl text-sm font-medium border-2 transition-all min-h-[44px] ${
              disabled ? 'cursor-default opacity-70' : ''
            } ${
              active
                ? 'bg-[#E8670A] border-[#E8670A] text-white'
                : 'bg-white border-gray-200 text-gray-700 hover:border-[#E8670A]/50'
            }`}
          >
            <span className={`flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center ${
              active ? 'bg-white/30 border-white' : 'border-gray-300'
            }`}>
              {active && (
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </span>
            {opt}
          </button>
        )
      })}
    </div>
  )
}

function FieldInput({ field, value, onChange, disabled }) {
  const base = 'w-full border-2 border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#E8670A] transition-colors'

  switch (field.type) {
    case 'rating':
      return <RatingField field={field} value={value} onChange={onChange} disabled={disabled} />
    case 'yes_no':
      return <YesNoField value={value} onChange={onChange} disabled={disabled} />
    case 'single_choice':
      return <SingleChoiceField field={field} value={value} onChange={onChange} disabled={disabled} />
    case 'multi_choice':
      return <MultiChoiceField field={field} value={value} onChange={onChange} disabled={disabled} />
    case 'long_text':
      return (
        <textarea
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          rows={4}
          maxLength={field.max_chars || undefined}
          placeholder={field.description || ''}
          disabled={disabled}
          className={`${base} resize-none disabled:bg-gray-50 disabled:cursor-default`}
        />
      )
    case 'number':
      return (
        <input
          type="number"
          value={value ?? ''}
          onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder={field.description || ''}
          disabled={disabled}
          className={`${base} disabled:bg-gray-50 disabled:cursor-default`}
        />
      )
    case 'date':
      return (
        <input
          type="date"
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          className={`${base} disabled:bg-gray-50 disabled:cursor-default`}
        />
      )
    default: // short_text
      return (
        <input
          type="text"
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          maxLength={field.max_chars || undefined}
          placeholder={field.description || ''}
          disabled={disabled}
          className={`${base} disabled:bg-gray-50 disabled:cursor-default`}
        />
      )
  }
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function FormFill() {
  const { getToken }    = useAuth()
  const { id }          = useParams()
  const navigate        = useNavigate()
  const [searchParams]  = useSearchParams()

  const isPreview    = searchParams.get('preview') === '1'
  const assignmentId = searchParams.get('assignment_id') ?? null

  const [form,         setForm]         = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [answers,      setAnswers]      = useState({})
  const [fieldErrors,  setFieldErrors]  = useState({})
  const [submitting,   setSubmitting]   = useState(false)
  const [submitted,    setSubmitted]    = useState(false)
  const [alreadyDone,  setAlreadyDone]  = useState(false)
  const submittedRef = useRef(false)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const endpoint = isPreview
          ? `${API_URL}/api/forms/${id}/preview`
          : `${API_URL}/api/forms/${id}/fill`
        const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error ?? `Error ${res.status}`)
        }
        setForm(await res.json())
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id, getToken, isPreview])

  function setAnswer(fieldId, value) {
    if (isPreview) return
    setAnswers(prev => ({ ...prev, [fieldId]: value }))
    setFieldErrors(prev => {
      if (!prev[fieldId]) return prev
      const next = { ...prev }
      delete next[fieldId]
      return next
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (isPreview || submittedRef.current) return
    const schema = form?.schema ?? []

    const errors = {}
    for (const field of schema) {
      if (field.type === 'text_block') continue
      if (!field.required) continue
      const val = answers[field.id]
      const empty = val === undefined || val === null || val === '' ||
                    (Array.isArray(val) && val.length === 0)
      if (empty) errors[field.id] = 'This field is required.'
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      const firstId = Object.keys(errors)[0]
      document.getElementById(`field-${firstId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }

    submittedRef.current = true
    setSubmitting(true)
    try {
      const token = await getToken()
      const body = { answers }
      if (assignmentId) body.assignment_id = assignmentId
      const res = await fetch(`${API_URL}/api/forms/${id}/submit`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        // 409 = already submitted this assignment
        if (res.status === 409 && d.already_submitted) {
          setAlreadyDone(true)
          return
        }
        throw new Error(d.error ?? 'Submission failed')
      }
      setSubmitted(true)
    } catch (e) {
      submittedRef.current = false
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  // ── Already completed state ──
  if (alreadyDone) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center">
        <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
          <svg className="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Already Submitted</h2>
        <p className="text-sm text-gray-500 mb-6">You've already completed "{form?.title}". No need to submit again.</p>
        <button onClick={() => navigate('/dashboard')}
          className="bg-[#E8670A] text-white font-bold px-6 py-3 rounded-xl text-sm hover:bg-[#c45e09] transition-colors">
          Back to Dashboard
        </button>
      </div>
    )
  }

  // ── Success screen ──
  if (submitted) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center">
        <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mb-4">
          <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Submitted!</h2>
        <p className="text-sm text-gray-500 mb-6">Thanks for completing "{form?.title}".</p>
        <button onClick={() => navigate('/dashboard')}
          className="bg-[#E8670A] text-white font-bold px-6 py-3 rounded-xl text-sm hover:bg-[#c45e09] transition-colors">
          Back to Dashboard
        </button>
      </div>
    )
  }

  if (loading) return <p className="text-center text-gray-400 py-16 text-sm">Loading form…</p>

  if (error) {
    return (
      <div className="text-center py-16 px-4">
        <p className="text-red-500 text-sm mb-4">{error}</p>
        <button onClick={() => navigate(-1)}
          className="text-sm text-[#E8670A] font-semibold hover:underline">← Go back</button>
      </div>
    )
  }

  const schema = form?.schema ?? []

  return (
    <div className="max-w-xl mx-auto pb-12">

      {/* Preview mode banner */}
      {isPreview && (
        <div className={`mb-5 rounded-xl px-4 py-3 text-sm font-medium flex items-start gap-2 ${
          form.is_draft
            ? 'bg-amber-50 border border-amber-200 text-amber-700'
            : 'bg-blue-50 border border-blue-200 text-blue-700'
        }`}>
          <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>
            {form.is_draft
              ? 'Preview showing draft schema — publish this form to make it available to clients.'
              : 'Preview Mode — this is how clients will see the form. No submission will be saved.'}
          </span>
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{form.title}</h1>
        {form.description && <p className="text-sm text-gray-500 mt-1">{form.description}</p>}
      </div>

      {/* Global error */}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
        {(() => {
          let qNum = 0
          return schema.map(field => {
            if (field.type === 'text_block') {
              return (
                <div key={field.id} className="rounded-2xl border border-blue-100 bg-blue-50/60 px-5 py-4">
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{field.label}</p>
                </div>
              )
            }
            qNum++
            return (
              <div
                key={field.id}
                id={`field-${field.id}`}
                className={`bg-white rounded-2xl border p-5 transition-colors ${
                  fieldErrors[field.id] ? 'border-red-300 bg-red-50/30' : 'border-gray-200'
                }`}
              >
                <label className="block mb-3">
                  <span className="text-sm font-bold text-gray-900">
                    {qNum}. {field.label}
                    {field.required && !isPreview && <span className="text-red-500 ml-1">*</span>}
                  </span>
                  {field.description && (
                    <span className="block text-xs text-gray-500 mt-0.5">{field.description}</span>
                  )}
                </label>

                <FieldInput
                  field={field}
                  value={answers[field.id]}
                  onChange={val => setAnswer(field.id, val)}
                  disabled={isPreview}
                />

                {fieldErrors[field.id] && (
                  <p className="mt-2 text-xs text-red-500 font-medium">{fieldErrors[field.id]}</p>
                )}
              </div>
            )
          })
        })()}

        {schema.length === 0 && (
          <p className="text-center text-gray-400 py-8 text-sm">This form has no questions yet.</p>
        )}

        {/* Submit / Preview-only footer */}
        {schema.length > 0 && (
          isPreview ? (
            <div className="w-full bg-gray-100 text-gray-400 font-semibold py-4 rounded-2xl text-base text-center cursor-default select-none">
              Preview only — no submission will be saved
            </div>
          ) : (
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-[#E8670A] text-white font-bold py-4 rounded-2xl text-base hover:bg-[#c45e09] disabled:opacity-60 transition-colors"
            >
              {submitting ? 'Submitting…' : 'Submit Form'}
            </button>
          )
        )}
      </form>
    </div>
  )
}
