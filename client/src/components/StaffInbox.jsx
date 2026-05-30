import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { API_URL } from '../config.js'
import { useVoiceRecorder } from '../hooks/useVoiceRecorder.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function _labels(iso) {
  if (!iso) return null
  const d = new Date(iso)
  const now = new Date()
  const yest = new Date(now); yest.setDate(yest.getDate() - 1)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const sameYear = d.getFullYear() === now.getFullYear()
  const dateStr = d.toLocaleDateString([], sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
  const isToday = d.toDateString() === now.toDateString()
  const isYest  = d.toDateString() === yest.toDateString()
  return { time, dateStr, isToday, isYest }
}

// Inbox-list short format: "Today 8:32 PM", "Yesterday", "May 15"
function fmtShort(iso) {
  const l = _labels(iso); if (!l) return ''
  if (l.isToday) return `Today ${l.time}`
  if (l.isYest)  return 'Yesterday'
  return l.dateStr
}

// Full format with time: "Today 8:32 PM", "Yesterday 8:32 PM", "May 15 8:32 PM"
function fmtFull(iso) {
  const l = _labels(iso); if (!l) return ''
  if (l.isToday) return `Today ${l.time}`
  if (l.isYest)  return `Yesterday ${l.time}`
  return `${l.dateStr} ${l.time}`
}

// Team tab is hidden from staff UI — thread data still exists, just not shown as a tab.
function parseMessageMetadata(metadata) {
  if (!metadata) return {}
  if (typeof metadata === 'object') return metadata
  if (typeof metadata !== 'string') return {}
  try {
    const parsed = JSON.parse(metadata)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function getAudioSources(url) {
  if (!url) return []
  const sources = [{
    src: url,
    type: url.includes('/f_mp3/')
      ? 'audio/mpeg'
      : url.includes('.webm')
        ? 'audio/webm'
        : url.includes('.mp4') || url.includes('.m4a')
          ? 'audio/mp4'
          : undefined,
  }]
  if (
    url.includes('res.cloudinary.com') &&
    url.includes('/video/upload/') &&
    !url.includes('/f_mp3/')
  ) {
    sources.push({ src: url.replace('/upload/', '/upload/f_mp3/'), type: 'audio/mpeg' })
  }
  return sources
}

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function VoiceMessagePlayer({ audioUrl, isMine }) {
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const sources = getAudioSources(audioUrl)
  const rangeMax = duration || 0

  useEffect(() => {
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
  }, [audioUrl])

  async function togglePlayback() {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
      return
    }
    try {
      await audio.play()
      setPlaying(true)
    } catch {
      setPlaying(false)
    }
  }

  function seek(e) {
    const nextTime = Number(e.target.value)
    const audio = audioRef.current
    if (audio) audio.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  return (
    <div className={`mt-1 flex w-[min(260px,100%)] max-w-full items-center gap-2 rounded-full px-2.5 py-2 ${
      isMine ? 'bg-white/95 text-gray-800' : 'bg-white/20 text-white'
    }`}>
      <button
        type="button"
        onClick={togglePlayback}
        className="flex h-9 min-w-9 items-center justify-center rounded-full bg-[#E8670A] text-white shadow-sm"
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
      >
        {playing ? (
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg className="ml-0.5 h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <input
        type="range"
        min="0"
        max={rangeMax}
        step="0.1"
        value={Math.min(currentTime, rangeMax)}
        onChange={seek}
        disabled={!duration}
        className="min-w-0 flex-1 accent-[#E8670A] disabled:opacity-40"
        aria-label="Voice message progress"
      />
      <span className="w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums opacity-70">
        {formatAudioTime(duration || currentTime)}
      </span>
      <audio
        ref={audioRef}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={e => {
          const nextDuration = e.currentTarget.duration
          setDuration(Number.isFinite(nextDuration) ? nextDuration : 0)
        }}
        onTimeUpdate={e => setCurrentTime(e.currentTarget.currentTime || 0)}
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
      >
        {sources.map(source => (
          <source key={source.src} src={source.src} type={source.type} />
        ))}
      </audio>
    </div>
  )
}

const STAFF_THREAD_LABELS = {
  coach_thread:  'Coach',
  admin_private: 'Jason',
  ai_admin:      'Support',
}
const STAFF_VISIBLE_THREADS = ['admin_private', 'coach_thread', 'ai_admin']

// ── Staff Inbox component ─────────────────────────────────────────────────────
// Reused on the Coaching → Messaging tab AND the main Messages page for staff.

export default function StaffInbox({ getToken, role }) {
  const [inbox,       setInbox]       = useState([])
  const [loading,     setLoading]     = useState(true)
  const [selected,    setSelected]    = useState(null) // { clientId, clientName, threadType }
  const [messages,     setMessages]     = useState([])
  const [hasMore,      setHasMore]      = useState(false)
  const [nextBeforeId, setNextBeforeId] = useState(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loadingMsgs,  setLoadingMsgs]  = useState(false)
  const [body,        setBody]        = useState('')
  const [sending,     setSending]     = useState(false)
  const scrollRef    = useRef(null)
  const selectedRef  = useRef(null)
  const msgCountRef  = useRef(0)
  const fileInputRef     = useRef(null)  // camera
  const galleryInputRef  = useRef(null)  // gallery/files
  const [imgPreview,  setImgPreview]  = useState(null)
  const [imgFile,     setImgFile]     = useState(null)
  const [uploading,   setUploading]   = useState(false)

  const [inboxView, setInboxView] = useState('active') // 'active' | 'archived'
  const [availableThreads, setAvailableThreads] = useState([]) // thread types for current client (ignores archive state)

  const { canRecord, recording, audioBlob, audioPreview, recordError, startRecording, stopRecording, clearAudio } = useVoiceRecorder()

  const ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']

  function handleFileSelect(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!ALLOWED.includes(file.type)) {
      alert('Unsupported file type. Please use JPG, PNG, or WebP.')
      e.target.value = ''; return
    }
    if (file.size > 10 * 1024 * 1024) {
      alert('File is too large. Maximum size is 10 MB.')
      e.target.value = ''; return
    }
    setImgFile(file)
    setImgPreview(URL.createObjectURL(file))
  }

  function clearImage() {
    setImgFile(null); setImgPreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function uploadImage(file) {
    setUploading(true)
    try {
      const token = await getToken()
      const fd = new FormData(); fd.append('image', file)
      const res = await fetch(`${API_URL}/api/messages/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      })
      if (!res.ok) throw new Error('Upload failed')
      return (await res.json()).url
    } finally { setUploading(false) }
  }

  async function uploadAudio(blob) {
    setUploading(true)
    try {
      const token = await getToken()
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm'
      const fd = new FormData(); fd.append('audio', blob, `voice-message.${ext}`)
      const res = await fetch(`${API_URL}/api/messages/upload-audio`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      })
      if (!res.ok) throw new Error('Audio upload failed')
      return (await res.json()).url
    } finally { setUploading(false) }
  }

  function rerecordAudio() {
    clearAudio()
    startRecording()
  }

  // ── Inbox state helpers (archive / mark-unread) ───────────────────────────
  async function patchInboxState(clientId, threadType, patch) {
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/coach-admin/messaging/states/${clientId}/${threadType}`, {
        method:  'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      })
    } catch {}
  }

  async function archiveConversation() {
    if (!selected) return
    await patchInboxState(selected.clientId, selected.threadType, { archived: true })
    selectedRef.current = null
    setSelected(null)
    fetchInbox()
  }

  async function unarchiveConversation() {
    if (!selected) return
    await patchInboxState(selected.clientId, selected.threadType, { archived: false })
    selectedRef.current = null
    setSelected(null)
    fetchInbox()
  }

  async function markUnread() {
    if (!selected) return
    await patchInboxState(selected.clientId, selected.threadType, { marked_unread: true })
    selectedRef.current = null
    setSelected(null)
    fetchInbox()
  }

  // Reset inboxView back to active & clear selection when switching tabs
  function switchView(view) {
    setInboxView(view)
    setSelected(null)
  }

  useEffect(() => { selectedRef.current = selected }, [selected])

  // ── Group inbox rows by client ────────────────────────────────────────────
  const groupedInbox = useMemo(() => {
    const map = new Map()
    for (const row of inbox) {
      const existing = map.get(row.client_id)
      // Full name: server now returns first_name as "First Last" (concat), but keep fallback
      const fullName = row.first_name ?? 'Client'
      if (!existing) {
        map.set(row.client_id, {
          client_id:          row.client_id,
          first_name:         fullName,
          full_name:          fullName,
          totalUnread:        Number(row.unread) || 0,
          totalMarkedUnread:  row.marked_unread ? 1 : 0,
          last_message_at:    row.last_message_at,
          last_message_body:  row.last_message_body,
          last_sender_role:   row.last_sender_role,
          latestThreadType:   row.thread_type,
          threads:            [row],
        })
      } else {
        existing.threads.push(row)
        existing.totalUnread       += Number(row.unread) || 0
        existing.totalMarkedUnread += row.marked_unread ? 1 : 0
        if (row.last_message_at && (!existing.last_message_at || new Date(row.last_message_at) > new Date(existing.last_message_at))) {
          existing.last_message_at   = row.last_message_at
          existing.last_message_body = row.last_message_body
          existing.last_sender_role  = row.last_sender_role
          existing.latestThreadType  = row.thread_type
        }
      }
    }
    return [...map.values()]
  }, [inbox])

  const selectedClientThreads = useMemo(
    () => inbox.filter(r => r.client_id === selected?.clientId),
    [inbox, selected?.clientId],
  )

  // ── Fetch inbox ───────────────────────────────────────────────────────────
  const fetchInbox = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/messaging/inbox?view=${inboxView}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const fresh = await res.json()
      setInbox(prev => {
        const sel = selectedRef.current
        if (!sel) return fresh
        return fresh.map(r =>
          r.client_id === sel.clientId && r.thread_type === sel.threadType
            ? { ...r, unread: 0, marked_unread: false } : r,
        )
      })
    } catch {}
  }, [getToken, inboxView])

  useEffect(() => { fetchInbox().finally(() => setLoading(false)) }, [fetchInbox])
  useEffect(() => {
    const id = setInterval(fetchInbox, 30_000)
    return () => clearInterval(id)
  }, [fetchInbox])

  // ── Load conversation ─────────────────────────────────────────────────────
  const loadConversation = useCallback(async (sel) => {
    if (!sel) return
    setLoadingMsgs(true)
    setHasMore(false)
    setNextBeforeId(null)
    // Clear "marked as unread" whenever a conversation is opened
    patchInboxState(sel.clientId, sel.threadType, { marked_unread: false }).catch(() => {})
    const token = await getToken()
    const res = await fetch(
      `${API_URL}/api/coach-admin/clients/${sel.clientId}/messages?thread=${sel.threadType}&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (res.ok) {
      const data = await res.json()
      const msgs = data.messages ?? []
      setMessages(msgs)
      setHasMore(data.hasMore ?? false)
      setNextBeforeId(data.nextBeforeId ?? null)
      msgCountRef.current = msgs.length
      setInbox(prev => prev.map(r =>
        r.client_id === sel.clientId && r.thread_type === sel.threadType
          ? { ...r, unread: 0 } : r,
      ))
    }
    setLoadingMsgs(false)
  }, [getToken])

  const loadOlder = useCallback(async () => {
    if (!selected || !nextBeforeId || loadingOlder) return
    setLoadingOlder(true)
    try {
      const token = await getToken()
      const res = await fetch(
        `${API_URL}/api/coach-admin/clients/${selected.clientId}/messages?thread=${selected.threadType}&limit=50&before_id=${nextBeforeId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (res.ok) {
        const data = await res.json()
        setMessages(prev => [...(data.messages ?? []), ...prev])
        setHasMore(data.hasMore ?? false)
        setNextBeforeId(data.nextBeforeId ?? null)
      }
    } finally { setLoadingOlder(false) }
  }, [selected, nextBeforeId, loadingOlder, getToken])

  useEffect(() => { loadConversation(selected) }, [selected, loadConversation])

  // Poll conversation every 20 s — merge/dedupe so older loaded messages are not dropped
  useEffect(() => {
    if (!selected) return
    const poll = async () => {
      try {
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/api/coach-admin/clients/${selected.clientId}/messages?thread=${selected.threadType}&limit=50`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (!res.ok) return
        const data = await res.json()
        const fresh = data.messages ?? []
        setMessages(prev => {
          const ids = new Set(prev.map(m => m.id))
          const merged = [...prev, ...fresh.filter(m => !ids.has(m.id))]
          merged.sort((a, b) => a.id - b.id)
          msgCountRef.current = merged.length
          return merged
        })
      } catch {}
    }
    const id = setInterval(poll, 20_000)
    return () => clearInterval(id)
  }, [selected, getToken])

  // Fetch all thread types for the selected client, ignoring archive state.
  // This lets the tab row show threads even if one is active and another is archived.
  useEffect(() => {
    if (!selected?.clientId) { setAvailableThreads([]); return }
    setAvailableThreads([]) // clear stale tabs from the previous client immediately
    let cancelled = false
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/api/coach-admin/clients/${selected.clientId}/thread-types`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (res.ok && !cancelled) setAvailableThreads(await res.json())
      } catch {}
    })()
    return () => { cancelled = true }
  }, [selected?.clientId, getToken])

  useEffect(() => {
    if (messages.length > 0 && messages.length >= msgCountRef.current) {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  async function send() {
    if (!body.trim() && !imgFile && !audioBlob) return
    if (sending || uploading) return
    setSending(true)
    try {
      let image_url = null, audio_url = null
      if (imgFile)   image_url = await uploadImage(imgFile)
      if (audioBlob) audio_url = await uploadAudio(audioBlob)
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${selected.clientId}/messages`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message_body: body, thread_type: selected.threadType, image_url, audio_url }),
      })
      if (res.ok) {
        const msg = await res.json()
        setMessages(m => [...m, msg])
        setBody(''); clearImage(); clearAudio()
        fetchInbox()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error ?? 'Could not send message')
      }
    } catch { alert('Could not send message') }
    finally { setSending(false) }
  }

  if (loading) return <p className="text-sm text-gray-400 py-8 text-center">Loading inbox…</p>

  const totalUnread = groupedInbox.reduce((sum, g) => sum + g.totalUnread + g.totalMarkedUnread, 0)

  return (
    <div className="flex flex-col lg:flex-row gap-4 min-h-[600px]">
      {/* Inbox list */}
      <div className={`lg:w-72 shrink-0 flex flex-col overflow-y-auto ${selected ? 'hidden lg:flex' : ''}`}>
        {/* Active / Archived tabs */}
        <div className="flex gap-1 mb-2">
          {(['active', 'archived'] ).map(v => (
            <button
              key={v}
              onClick={() => switchView(v)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                inboxView === v
                  ? 'bg-[#E8670A] text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {v === 'active' ? 'Active' : 'Archived'}
            </button>
          ))}
        </div>
        {totalUnread > 0 && inboxView === 'active' && (
          <p className="text-xs font-semibold text-[#E8670A] mb-2 px-1">
            {totalUnread} unread message{totalUnread !== 1 ? 's' : ''}
          </p>
        )}
        <div className="flex-1 space-y-1.5">
        {!loading && groupedInbox.length === 0 && (
          <p className="text-xs text-gray-400 text-center py-6 px-2">
            {inboxView === 'archived' ? 'No archived conversations.' : 'No messages yet. Client conversations will appear here.'}
          </p>
        )}
        {groupedInbox.map(g => {
          const isSelected = selected?.clientId === g.client_id
          const hasUnread  = g.totalUnread > 0 || g.totalMarkedUnread > 0
          return (
            <button
              key={g.client_id}
              onClick={() => setSelected({ clientId: g.client_id, clientName: g.full_name, threadType: g.latestThreadType })}
              className={`w-full text-left border rounded-xl px-3 py-3 transition-all ${
                isSelected
                  ? 'bg-[#E8670A] border-[#E8670A] text-white shadow-md'
                  : hasUnread
                    ? 'bg-orange-50 border-orange-200 hover:border-[#E8670A]'
                    : 'bg-white border-gray-200 hover:border-[#E8670A]'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-semibold ${isSelected ? 'text-white' : 'text-gray-900'}`}>
                    {g.full_name}
                  </p>
                  <p className={`text-[10px] mt-0.5 ${isSelected ? 'text-white/70' : 'text-gray-400'}`}>
                    {g.last_message_at ? fmtShort(g.last_message_at) : ''}
                    {g.threads.length > 1 && (
                      <span className={`ml-1 ${isSelected ? 'text-white/60' : 'text-gray-300'}`}>
                        · {g.threads.length} threads
                      </span>
                    )}
                  </p>
                  {g.last_message_body && (
                    <p className={`text-xs mt-1 truncate ${
                      isSelected ? 'text-white/80' : hasUnread ? 'text-gray-800 font-medium' : 'text-gray-500'
                    }`}>
                      {g.last_sender_role !== 'client' && <span className="opacity-60">You: </span>}
                      {g.last_message_body}
                    </p>
                  )}
                </div>
                {hasUnread && !isSelected && (
                  <span className="bg-[#E8670A] text-white text-[10px] font-bold rounded-full px-2 py-0.5 shrink-0 mt-0.5">
                    {g.totalUnread > 0 ? g.totalUnread : '●'}
                  </span>
                )}
              </div>
            </button>
          )
        })}
        </div>{/* end inner list */}
      </div>

      {/* Conversation panel */}
      <div className={`flex-1 flex-col bg-white border border-gray-200 rounded-xl overflow-hidden ${selected ? 'flex' : 'hidden lg:flex'}`}>
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
            Select a client to view messages
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSelected(null)}
                  className="lg:hidden -ml-1 min-w-10 h-10 flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-200 transition-colors shrink-0"
                  aria-label="Back to inbox"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <p className="text-sm font-semibold text-gray-900 flex-1 min-w-0 truncate">{selected.clientName}</p>
                {/* Mark as Unread — only in active view */}
                {inboxView === 'active' && (
                  <button
                    onClick={markUnread}
                    title="Mark as unread"
                    className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-gray-600 bg-white border border-gray-200 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors"
                  >
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" /></svg>
                    Unread
                  </button>
                )}
                {/* Archive / Unarchive */}
                {inboxView === 'active' ? (
                  <button
                    onClick={archiveConversation}
                    title="Archive conversation"
                    className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-gray-600 bg-white border border-gray-200 hover:border-gray-400 hover:text-gray-800 transition-colors"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 12a2 2 0 002 2h8a2 2 0 002-2L19 8M10 12h4" /></svg>
                    Archive
                  </button>
                ) : (
                  <button
                    onClick={unarchiveConversation}
                    title="Move back to active"
                    className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-[#E8670A] bg-orange-50 border border-orange-200 hover:bg-orange-100 transition-colors"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                    Restore
                  </button>
                )}
              </div>
              {availableThreads.length > 1 && (
                <div className="flex gap-1 mt-2 flex-wrap">
                  {availableThreads.map(t => {
                    const threadUnread = Number(t.unread) || 0
                    const isActive = selected.threadType === t.thread_type
                    return (
                      <button
                        key={t.thread_type}
                        onClick={() => setSelected(s => ({ ...s, threadType: t.thread_type }))}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                          isActive
                            ? 'bg-[#E8670A] text-white'
                            : 'bg-white border border-gray-300 text-gray-600 hover:border-[#E8670A]'
                        }`}
                      >
                        {STAFF_THREAD_LABELS[t.thread_type] ?? t.thread_type}
                        {threadUnread > 0 && !isActive && (
                          <span className="bg-[#E8670A] text-white text-[9px] font-bold rounded-full px-1.5 py-0.5">
                            {threadUnread}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 bg-gray-50 space-y-3 max-h-[500px]">
              {hasMore && !loadingMsgs && (
                <div className="text-center pb-1">
                  <button
                    onClick={loadOlder}
                    disabled={loadingOlder}
                    className="text-xs text-gray-500 hover:text-[#E8670A] disabled:opacity-40 underline"
                  >
                    {loadingOlder ? 'Loading…' : 'Load older messages'}
                  </button>
                </div>
              )}
              {loadingMsgs && <p className="text-center text-xs text-gray-400">Loading…</p>}
              {!loadingMsgs && messages.length === 0 && (
                <p className="text-center text-xs text-gray-400 py-8">No messages in this thread yet.</p>
              )}
              {messages.map(m => {
                const isStaff = m.sender_role === 'admin' || m.sender_role === 'coach'
                const metadata = parseMessageMetadata(m.metadata)
                return (
                  <div key={m.id} className={`flex ${isStaff ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                      isStaff ? 'bg-[#E8670A] text-white' : 'bg-blue-500 text-white'
                    }`}>
                      <p className="text-[10px] font-semibold text-white/70 mb-0.5">
                        {m.sender_name ?? m.sender_role} · {fmtFull(m.created_at)}
                      </p>
                      {m.message_body && <p className="text-sm whitespace-pre-wrap">{m.message_body}</p>}
                      {m.image_url && (
                        <img src={m.image_url} alt="attachment" className="max-w-[240px] rounded-lg mt-1 cursor-pointer" onClick={() => window.open(m.image_url, '_blank')} />
                      )}
                      {m.audio_url && (
                        <VoiceMessagePlayer audioUrl={m.audio_url} isMine={isStaff} />
                      )}
                      {metadata.form_id && (
                        <div className="mt-2 flex items-center gap-1.5 bg-white/20 border border-white/30 rounded-lg px-3 py-2 text-xs font-bold">
                          <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                          </svg>
                          <span>
                            Form attached: {metadata.form_title ?? 'Form'}
                            <span className="block text-[10px] font-semibold opacity-80">Client sees: Open Check-In</span>
                          </span>
                        </div>
                      )}
                      {isStaff && (
                        <p className="text-[9px] opacity-60 text-right mt-0.5">
                          {m.read_at ? `Read ${fmtFull(m.read_at)}` : 'Not read'}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            {/* Read-only notice for admins viewing a coach thread */}
            {role === 'admin' && selected?.threadType === 'coach_thread' ? (
              <div className="border-t border-gray-100 px-4 py-3">
                <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  👁 Viewing coach–client thread read-only. Switch to the <strong>{STAFF_THREAD_LABELS['admin_private'] ?? 'Account Owner'}</strong> tab to send your own message.
                </p>
              </div>
            ) : (
            <div className="border-t border-gray-100 p-3 space-y-2">
              {imgPreview && (
                <div className="relative inline-block">
                  <img src={imgPreview} alt="preview" className="max-h-28 rounded-lg border border-gray-200" />
                  <button onClick={clearImage} className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center leading-none font-bold">×</button>
                </div>
              )}
              {audioPreview && (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                  <audio controls src={audioPreview} className="w-full sm:flex-1 min-w-0" style={{ height: 32 }} />
                  <div className="flex items-center gap-2">
                    <button onClick={rerecordAudio} disabled={recording} className="min-h-9 px-3 rounded-lg bg-white border border-orange-200 text-xs font-semibold text-[#E8670A] hover:border-[#E8670A] disabled:opacity-40">
                      Rerecord
                    </button>
                    <button onClick={clearAudio} title="Discard recording" className="shrink-0 min-w-9 h-9 flex items-center justify-center rounded-lg bg-red-100 text-red-600 hover:bg-red-200 text-xs font-bold leading-none">x</button>
                  </div>
                </div>
              )}
              {recording && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-xs text-red-600 font-medium">Recording… tap ■ to stop</span>
                </div>
              )}
              {recordError && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {recordError === 'not_supported' && 'Voice recording is not supported in this browser.'}
                  {recordError === 'permission_denied' && 'Microphone access was denied. Please allow microphone access and try again.'}
                  {recordError === 'unknown' && 'Could not start recording. Please try again.'}
                </p>
              )}
              <div className="space-y-2 pb-[env(safe-area-inset-bottom)]">
                {/* Camera — capture from device camera */}
                <input ref={fileInputRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" capture="environment" className="hidden" onChange={handleFileSelect} />
                {/* Gallery — pick from files/photos */}
                <input ref={galleryInputRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" className="hidden" onChange={handleFileSelect} />
                <div className="flex items-stretch gap-2">
                  <textarea
                    value={body}
                    onChange={e => setBody(e.target.value)}
                    placeholder={`Message ${selected.clientName ?? 'client'}…`}
                    rows={3}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                    className="flex-1 min-w-0 min-h-[84px] max-h-36 border border-gray-300 rounded-lg px-3 py-2 text-sm leading-5 focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none overflow-y-auto"
                  />
                  <button
                    onClick={send}
                    disabled={sending || uploading || (!body.trim() && !imgFile && !audioBlob)}
                    className="bg-[#E8670A] text-white px-3 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 min-w-[64px] sm:min-w-[76px]"
                  >
                    {uploading ? '⬆' : sending ? '…' : 'Send'}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => fileInputRef.current?.click()} disabled={!!audioBlob || recording} title="Take photo" className="shrink-0 min-w-10 h-10 sm:min-w-11 sm:h-11 px-2.5 sm:px-3 flex items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A] disabled:opacity-30 transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  </button>
                  <button onClick={() => galleryInputRef.current?.click()} disabled={!!audioBlob || recording} title="Choose from gallery" className="shrink-0 min-w-10 h-10 sm:min-w-11 sm:h-11 px-2.5 sm:px-3 flex items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A] disabled:opacity-30 transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  </button>
                  <button
                    onClick={recording ? stopRecording : startRecording}
                    disabled={!!imgFile}
                    title={!canRecord ? 'Voice recording not supported in this browser' : recording ? 'Stop recording' : 'Record voice message'}
                    className={`shrink-0 min-w-10 h-10 sm:min-w-11 sm:h-11 px-2.5 sm:px-3 flex items-center justify-center rounded-lg border transition-colors disabled:opacity-30 ${
                      recording
                        ? 'bg-red-500 border-red-500 text-white animate-pulse'
                        : 'border-gray-300 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A]'
                    }`}
                  >
                    {recording ? (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
            )} {/* end role=admin coach_thread read-only gate */}
          </>
        )}
      </div>
    </div>
  )
}
