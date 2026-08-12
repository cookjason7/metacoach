import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { Capacitor } from '@capacitor/core'
import { API_URL } from '../config.js'
import LinkifiedText from './LinkifiedText.jsx'
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

// Local YYYY-MM-DD for <input type="date"> — same helper shape the forms
// scheduling UI uses (client/src/pages/admin/FormsList.jsx). Deliberately not
// toISOString().slice(0,10), which shifts to UTC and can hand back yesterday.
function localDateInputValue(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Full format with time: "Today 8:32 PM", "Yesterday 8:32 PM", "May 15 8:32 PM"
function fmtFull(iso) {
  const l = _labels(iso); if (!l) return ''
  if (l.isToday) return `Today ${l.time}`
  if (l.isYest)  return `Yesterday ${l.time}`
  return `${l.dateStr} ${l.time}`
}

// Kept in sync with message_reactions.reaction_type's CHECK constraint (server/db.js) —
// same emoji set as community post_reactions, for visual consistency across the app.
const REACTION_OPTIONS = [
  { type: 'like',  emoji: '👍' },
  { type: 'love',  emoji: '❤️' },
  { type: 'laugh', emoji: '😂' },
  { type: 'care',  emoji: '🤗' },
]

// interactive=false on your own message bubbles — you can't react to your own message,
// so pills there are a read-only count display, not a toggle.
function ReactionPills({ reactions, onToggle, interactive = true }) {
  const visible = (reactions ?? []).filter(r => r.count > 0)
  if (visible.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {visible.map(r => {
        const opt = REACTION_OPTIONS.find(o => o.type === r.reaction_type)
        const pillClasses = `flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold border transition-colors ${
          r.mine
            ? 'bg-orange-50 border-[#E8670A] text-[#E8670A]'
            : 'bg-white border-gray-200 text-gray-600' + (interactive ? ' hover:border-gray-300' : '')
        }`
        return interactive ? (
          <button
            key={r.reaction_type}
            type="button"
            onClick={() => onToggle(r.reaction_type)}
            aria-label={`${r.mine ? 'Remove' : 'Add'} ${r.reaction_type} reaction`}
            className={pillClasses}
          >
            <span>{opt?.emoji ?? '👍'}</span><span>{r.count}</span>
          </button>
        ) : (
          <span key={r.reaction_type} className={pillClasses}>
            <span>{opt?.emoji ?? '👍'}</span><span>{r.count}</span>
          </span>
        )
      })}
    </div>
  )
}

function ReactionPicker({ onPick }) {
  return (
    <div className="flex items-center gap-0.5 bg-white border border-gray-200 rounded-full shadow-lg px-1 py-1">
      {REACTION_OPTIONS.map(opt => (
        <button
          key={opt.type}
          type="button"
          onClick={() => onPick(opt.type)}
          aria-label={`React with ${opt.type}`}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center text-lg rounded-full hover:bg-gray-100 transition-colors"
        >
          {opt.emoji}
        </button>
      ))}
    </div>
  )
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

// focusClientId/focusClientName: when provided, the inbox opens directly to that
// client's conversation (used for the dashboard's per-row "Message" quick action).
export default function StaffInbox({ getToken, role, focusClientId = null, focusClientName = null }) {
  const [inbox,       setInbox]       = useState([])
  const [loading,     setLoading]     = useState(true)
  const [selected,    setSelected]    = useState(null) // { clientId, clientName, threadType }
  const [messages,     setMessages]     = useState([])
  const [hasMore,      setHasMore]      = useState(false)
  const [nextBeforeId, setNextBeforeId] = useState(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loadingMsgs,  setLoadingMsgs]  = useState(false)
  // In-progress compose text per conversation, keyed "clientId:threadType" (same
  // keying as the reactMsgId/menuMsgId reset effect below) — so switching
  // conversations naturally shows the right draft instead of leaking text across clients.
  const [drafts,      setDrafts]      = useState({})
  const draftKey = selected ? `${selected.clientId}:${selected.threadType}` : null
  const body = draftKey ? (drafts[draftKey] ?? '') : ''
  const setBody = (text) => {
    if (!draftKey) return
    setDrafts(prev => ({ ...prev, [draftKey]: text }))
  }
  const [sending,     setSending]     = useState(false)
  const [toast,       setToast]       = useState(null) // { msg: string, type: 'error'|'info' }
  // ── Scheduled sends ────────────────────────────────────────────────────────
  // Queued messages live in their own table (scheduled_messages) and only appear
  // in `messages` once the server job actually delivers them — nothing here
  // filters or otherwise touches the client_messages fetch above.
  const [scheduling,      setScheduling]      = useState(false) // date/time panel open
  const [schedDate,       setSchedDate]       = useState('')
  const [schedTime,       setSchedTime]       = useState('09:00')
  const [savingSchedule,  setSavingSchedule]  = useState(false)
  const [scheduled,       setScheduled]       = useState([])    // pending rows for this thread
  const [scheduleNotice,  setScheduleNotice]  = useState(null)  // lightweight post-schedule confirmation
  const scrollRef      = useRef(null)
  const bottomRef      = useRef(null) // sentinel after the last message — scrollIntoView works regardless of which ancestor is the actual scrolling container (panel's own overflow-y-auto at md+, the page at mobile)
  const threadListRef  = useRef(null) // scrollable thread-list container — scrolled to top on "back"
  const backToListPendingRef = useRef(false) // set by backToList(), consumed once selected actually clears
  const selectedRef    = useRef(null)
  const msgCountRef    = useRef(0)
  const forceScrollRef = useRef(false) // set true right before a fresh conversation load lands — jump to bottom unconditionally, ignoring scroll position
  const didSendRef     = useRef(false) // set true right before appending the message *I* just sent — always follow my own message to the bottom
  const didPrependRef  = useRef(false) // set true right before loadOlder() prepends history — must NOT scroll to bottom (that would undo the scroll-up)
  const fileInputRef     = useRef(null)  // camera
  const galleryInputRef  = useRef(null)  // gallery/files
  const [imgPreview,  setImgPreview]  = useState(null)
  const [imgFile,     setImgFile]     = useState(null)
  const [uploading,   setUploading]   = useState(false)
  const [myId,        setMyId]        = useState(null) // current staff user's db id — identifies own messages
  const [menuMsgId,   setMenuMsgId]   = useState(null) // message id with delete affordance revealed (mobile long-press)
  const [reactMsgId,  setReactMsgId]  = useState(null) // message id with reaction picker open
  const [editingMsgId, setEditingMsgId] = useState(null) // message id currently being edited
  const [editText,     setEditText]     = useState('')
  const [savingEdit,   setSavingEdit]   = useState(false)
  const longPressTimer = useRef(null)
  const reactLongPressTimer = useRef(null)

  const [inboxView, setInboxView] = useState('active') // 'active' | 'archived'
  const [availableThreads, setAvailableThreads] = useState([]) // thread types for current client (ignores archive state)

  function showToast(msg, type = 'error') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  // ── Client search (compose new conversation) ──────────────────────────────
  const [searchQuery,   setSearchQuery]   = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const searchRef = useRef(null) // input ref for focus management

  const { canRecord, recording, audioBlob, audioPreview, recordError, startRecording, stopRecording, clearAudio } = useVoiceRecorder()

  const ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']

  // Validate + stage an image File (shared by the file input and native camera capture).
  function applyImageFile(file) {
    if (!file) return false
    if (!ALLOWED.includes(file.type)) {
      alert('Unsupported file type. Please use JPG, PNG, or WebP.')
      return false
    }
    if (file.size > 10 * 1024 * 1024) {
      alert('File is too large. Maximum size is 10 MB.')
      return false
    }
    setImgFile(file)
    setImgPreview(URL.createObjectURL(file))
    return true
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!applyImageFile(file)) e.target.value = ''
  }

  // The Android WebView ignores <input type="file" capture="environment"> and opens the
  // gallery instead of the camera. On native, use @capacitor/camera to capture directly;
  // on web, fall back to the hidden file input (which honours capture in real browsers).
  async function capturePhoto() {
    if (!Capacitor.isNativePlatform()) { fileInputRef.current?.click(); return }
    try {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.Uri,
        source:     CameraSource.Camera,
        quality:    90,
      })
      if (!photo?.webPath) return
      const blob = await (await fetch(photo.webPath)).blob()
      const type = blob.type || 'image/jpeg'
      const ext  = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'
      applyImageFile(new File([blob], `camera-photo.${ext}`, { type }))
    } catch (err) {
      // getPhoto rejects when the user cancels — ignore that, surface real failures.
      if (!/cancel/i.test(err?.message || '')) {
        console.error('Camera capture error:', err)
        alert('Could not capture photo. Please try again.')
      }
    }
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
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/messaging/states/${clientId}/${threadType}`, {
      method:  'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
    })
    if (!res.ok) throw new Error(`Server error ${res.status}`)
  }

  async function archiveConversation() {
    if (!selected) return
    try {
      await patchInboxState(selected.clientId, selected.threadType, { archived: true })
      selectedRef.current = null
      setSelected(null)
      fetchInbox()
    } catch {
      showToast('Could not archive thread. Please try again.')
    }
  }

  async function unarchiveConversation() {
    if (!selected) return
    try {
      await patchInboxState(selected.clientId, selected.threadType, { archived: false })
      selectedRef.current = null
      setSelected(null)
      fetchInbox()
    } catch {
      showToast('Could not unarchive thread. Please try again.')
    }
  }

  async function markUnread() {
    if (!selected) return
    try {
      await patchInboxState(selected.clientId, selected.threadType, { marked_unread: true })
      selectedRef.current = null
      setSelected(null)
      fetchInbox()
    } catch {
      showToast('Could not mark as unread. Please try again.')
    }
  }

  // Reset inboxView back to active & clear selection when switching tabs
  function switchView(view) {
    setInboxView(view)
    setSelected(null)
  }

  useEffect(() => { selectedRef.current = selected }, [selected])

  // Runs once `selected` has actually cleared and the DOM has committed that
  // change — see backToList() below for why a plain scrollTo/scrollIntoView
  // called directly from the click handler (or even deferred a frame or two
  // via requestAnimationFrame) isn't reliable enough here.
  useEffect(() => {
    if (selected || !backToListPendingRef.current) return
    backToListPendingRef.current = false
    const el = threadListRef.current
    if (!el) return

    // scrollIntoView walks up and scrolls whichever ancestor actually has the
    // overflow — on the standalone Messages page that's the page's own <main>
    // (in Layout.jsx, outside this component's reach), not this div. scrollTo
    // covers the case where this div itself is the scroll container instead
    // (e.g. the dashboard's quick-message modal).
    const jumpToTop = () => {
      if (typeof el.scrollIntoView === 'function') {
        try { el.scrollIntoView(true) } catch { /* ignore */ }
      }
      if (typeof el.scrollTo === 'function') {
        try { el.scrollTo({ top: 0, behavior: 'auto' }) } catch { el.scrollTop = 0 }
      } else {
        el.scrollTop = 0
      }
    }

    // Best-effort smooth scroll first, for a nicer feel on browsers/devices
    // where the animation actually plays...
    if (typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch { /* ignore */ }
    }
    if (typeof el.scrollTo === 'function') {
      try { el.scrollTo({ top: 0, behavior: 'smooth' }) } catch { /* ignore */ }
    }
    // ...followed by a guaranteed instant correction shortly after, since some
    // mobile/WebView browsers silently no-op the smooth option entirely. This
    // is what actually fixes it landing in the middle of the list instead of
    // the top on those devices.
    const t = setTimeout(jumpToTop, 400)
    return () => clearTimeout(t)
  }, [selected])

  // Holds a pending focusClientId (dashboard "Message" quick action, or a message
  // push notification deep link via Messages.jsx) until the inbox has loaded.
  // Selecting immediately — before groupedInbox is populated — meant we could
  // only guess the thread type instead of using the client's real thread, and
  // sometimes lost the race with the initial fetch so nothing got selected.
  // Consumed by the effect below, after groupedInbox is declared.
  const pendingClientIdRef = useRef(null)
  useEffect(() => {
    if (focusClientId != null) pendingClientIdRef.current = focusClientId
  }, [focusClientId])

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
          isAssignedCoach:    row.is_assigned_coach === true,
          threads:            [row],
        })
      } else {
        existing.threads.push(row)
        existing.totalUnread       += Number(row.unread) || 0
        existing.totalMarkedUnread += row.marked_unread ? 1 : 0
      }
    }
    // The card preview (message snippet, timestamp) and the thread the card opens into
    // must always come from the same row, or a client with two separate conversations
    // (coach_thread + admin_private) can show one conversation's text while clicking
    // into the other — see e28b308, which fixed the click target but left the preview
    // on independent "most recent message" logic. is_preview_thread is computed once,
    // server-side (markPreviewThread in coachAdmin.js), so both are always in sync.
    for (const g of map.values()) {
      const previewRow = g.threads.find(t => t.is_preview_thread) ?? g.threads[0]
      g.last_message_at   = previewRow.last_message_at
      g.last_message_body = previewRow.last_message_body
      g.last_sender_role  = previewRow.last_sender_role
      g.last_sender_id    = previewRow.last_sender_id
      g.latestThreadType  = previewRow.thread_type
    }
    const list = [...map.values()]
    // Mirror the server's ORDER BY: unread/marked-unread first, then most-recent.
    list.sort((a, b) => {
      const aUnread = (a.totalUnread > 0 || a.totalMarkedUnread > 0) ? 1 : 0
      const bUnread = (b.totalUnread > 0 || b.totalMarkedUnread > 0) ? 1 : 0
      if (bUnread !== aUnread) return bUnread - aUnread
      const aTime = a.last_message_at ? new Date(a.last_message_at).getTime() : 0
      const bTime = b.last_message_at ? new Date(b.last_message_at).getTime() : 0
      return bTime - aTime
    })
    return list
  }, [inbox])

  // Consume a pending focusClientId once inbox data is available: prefer a real
  // match from groupedInbox (correct thread type, name, and coach-assignment),
  // falling back to a best-guess only once the initial load finishes with no
  // match at all (e.g. a brand-new client with no messages yet — the
  // dashboard's per-row "Message" quick action).
  useEffect(() => {
    const pendingId = pendingClientIdRef.current
    if (pendingId == null) return

    const match = groupedInbox.find(g => g.client_id === pendingId)
    if (match) {
      setSelected({
        clientId:        match.client_id,
        clientName:      match.full_name,
        threadType:      match.latestThreadType,
        isAssignedCoach: match.isAssignedCoach,
      })
      pendingClientIdRef.current = null
      window.history.replaceState({}, '', window.location.pathname)
      return
    }

    if (!loading) {
      const threadType = (role === 'admin' || role === 'account_owner') ? 'admin_private' : 'coach_thread'
      setSelected({ clientId: pendingId, clientName: focusClientName, threadType, isAssignedCoach: false })
      pendingClientIdRef.current = null
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [focusClientId, groupedInbox, loading, role, focusClientName])

  const selectedClientThreads = useMemo(
    () => inbox.filter(r => r.client_id === selected?.clientId),
    [inbox, selected?.clientId],
  )

  // ── Debounced client search ───────────────────────────────────────────────
  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) { setSearchResults([]); setSearchLoading(false); return }
    setSearchLoading(true)
    const id = setTimeout(async () => {
      try {
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/api/coach-admin/messaging/client-search?q=${encodeURIComponent(q)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (res.ok) setSearchResults(await res.json())
      } catch {}
      finally { setSearchLoading(false) }
    }, 280)
    return () => clearTimeout(id)
  }, [searchQuery, getToken])

  function openClientConversation(client) {
    // Default thread: coaches use coach_thread, admins use admin_private — unless this
    // admin is the client's assigned coach, in which case it's a single merged thread.
    const isAssignedCoach = (role === 'admin' || role === 'account_owner') && client.is_assigned_coach === true
    const threadType = isAssignedCoach
      ? 'coach_thread'
      : (role === 'admin' || role === 'account_owner') ? 'admin_private' : 'coach_thread'
    setSelected({
      clientId:   client.id,
      clientName: client.full_name,
      threadType,
      isAssignedCoach,
    })
    setSearchQuery('')
    setSearchResults([])
  }

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

  // Identify the current staff user so we only offer delete on their own messages.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok && !cancelled) { const me = await res.json(); setMyId(me.id ?? null) }
      } catch {}
    })()
    return () => { cancelled = true }
  }, [getToken])

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
      forceScrollRef.current = true
      setMessages(msgs)
      setHasMore(data.hasMore ?? false)
      setNextBeforeId(data.nextBeforeId ?? null)
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
        didPrependRef.current = true
        setMessages(prev => [...(data.messages ?? []), ...prev])
        setHasMore(data.hasMore ?? false)
        setNextBeforeId(data.nextBeforeId ?? null)
      }
    } finally { setLoadingOlder(false) }
  }, [selected, nextBeforeId, loadingOlder, getToken])

  useEffect(() => { loadConversation(selected) }, [selected, loadConversation])

  // Pending scheduled sends for the open conversation. Keyed on clientId/threadType
  // rather than the `selected` object so unrelated re-selects don't refetch.
  const fetchScheduled = useCallback(async () => {
    if (!selected?.clientId || !selected?.threadType) { setScheduled([]); return }
    try {
      const token = await getToken()
      const res = await fetch(
        `${API_URL}/api/coach-admin/clients/${selected.clientId}/scheduled-messages?thread=${selected.threadType}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (res.ok) {
        const data = await res.json()
        setScheduled(data.pending ?? [])
      }
    } catch {}
  }, [selected?.clientId, selected?.threadType, getToken])

  useEffect(() => { fetchScheduled() }, [fetchScheduled])

  // Close any open reaction picker / delete affordance when switching conversations
  useEffect(() => { setReactMsgId(null); setMenuMsgId(null) }, [selected?.clientId, selected?.threadType])

  // Reset the schedule panel and its confirmation when switching conversations,
  // so a draft time never carries over to a different client.
  useEffect(() => {
    setScheduling(false)
    setSchedDate(''); setSchedTime('09:00')
    setScheduleNotice(null)
  }, [selected?.clientId, selected?.threadType])

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
          const newOnes = fresh.filter(m => !ids.has(m.id))
          if (newOnes.length === 0) return prev
          const merged = [...prev, ...newOnes]
          merged.sort((a, b) => a.id - b.id)
          return merged
        })
        // Keep the pending list in step: once the job delivers a queued message
        // it arrives above as a normal message and must drop out of "Scheduled".
        fetchScheduled()
      } catch {}
    }
    const id = setInterval(poll, 20_000)
    return () => clearInterval(id)
  }, [selected, getToken, fetchScheduled])

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

  // When admin IS the assigned coach and somehow lands on admin_private,
  // auto-switch to coach_thread once availableThreads confirms it exists.
  useEffect(() => {
    if (
      selected?.isAssignedCoach &&
      selected?.threadType === 'admin_private' &&
      availableThreads.some(t => t.thread_type === 'coach_thread')
    ) {
      setSelected(s => s ? { ...s, threadType: 'coach_thread' } : s)
    }
  }, [selected?.isAssignedCoach, selected?.threadType, availableThreads])

  // Heuristic for "is the user already looking at the bottom of the thread": if
  // scrollRef is itself the scrolling ancestor (md+, bounded panel) and is scrolled
  // within `threshold` of its end, or — when the panel isn't independently scrollable
  // (mobile, where the page itself is the scrolling ancestor — see the panel's
  // overflow-visible comment below) — the bottom sentinel is within `threshold` of
  // the bottom of the visible viewport.
  function isNearBottom(threshold = 100) {
    const el = scrollRef.current
    if (el && el.scrollHeight > el.clientHeight + 4) {
      return el.scrollTop + el.clientHeight >= el.scrollHeight - threshold
    }
    const sentinel = bottomRef.current
    if (!sentinel) return true
    const rect = sentinel.getBoundingClientRect()
    return rect.top <= (window.innerHeight || document.documentElement.clientHeight) + threshold
  }

  // Auto-scroll-to-bottom must not fire on every [messages] change — a 20s poll tick,
  // a reaction toggle, an edit save, or a read-receipt update all replace `messages`
  // too, none of which mean "jump the reader to the bottom." Only do that when the
  // message count genuinely grew (a real new message, not same-length map()) AND
  // either the staff member was already near the bottom, or the growth is their own
  // just-sent message — plus the unconditional cases: a fresh conversation just loaded
  // (forceScrollRef), or older history was prepended by loadOlder(), which must NOT
  // scroll (didPrependRef) — otherwise scrolling up to load history immediately
  // snapped back down to the bottom.
  useEffect(() => {
    if (didPrependRef.current) { didPrependRef.current = false; msgCountRef.current = messages.length; return }

    const grew  = messages.length > msgCountRef.current
    const force = forceScrollRef.current
    const mine  = didSendRef.current
    msgCountRef.current = messages.length
    forceScrollRef.current = false
    didSendRef.current = false

    if (!force && !grew) return
    if (force || mine || isNearBottom()) {
      // scrollIntoView (not scrollRef.scrollTop) so this works whether the message
      // list scrolls internally (md+, bounded panel) or the page itself is the
      // scrolling ancestor (mobile — see the panel's overflow-visible comment below).
      bottomRef.current?.scrollIntoView({ block: 'end' })
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
        didSendRef.current = true
        setMessages(m => [...m, msg])
        setBody(''); clearImage(); clearAudio()
        fetchInbox()
      } else {
        const err = await res.json().catch(() => ({}))
        showToast(err.error ?? 'Failed to send. Please try again.')
      }
    } catch { showToast('Failed to send. Please try again.') }
    finally { setSending(false) }
  }

  // Queue the composed message for later instead of sending it now. Mirrors
  // send() — same upload path, same clear-on-success — but hits the
  // scheduled-messages endpoint and leaves the thread untouched until the job runs.
  async function scheduleMessage() {
    if (!selected) return
    if (!body.trim() && !imgFile && !audioBlob) return
    if (savingSchedule || uploading) return
    if (!schedDate || !schedTime) { showToast('Please pick a date and time.'); return }

    // Parsed as local time (no trailing Z) so the picker means what the staff
    // member sees; toISOString() then hands the server an unambiguous UTC instant.
    const sendAt = new Date(`${schedDate}T${schedTime}:00`)
    if (Number.isNaN(sendAt.getTime())) { showToast('That date and time is not valid.'); return }
    if (sendAt.getTime() <= Date.now()) { showToast('Pick a date and time in the future.'); return }

    setSavingSchedule(true)
    try {
      let image_url = null, audio_url = null
      if (imgFile)   image_url = await uploadImage(imgFile)
      if (audioBlob) audio_url = await uploadAudio(audioBlob)
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${selected.clientId}/scheduled-messages`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message_body: body,
          thread_type:  selected.threadType,
          send_at:      sendAt.toISOString(),
          image_url,
          audio_url,
        }),
      })
      if (res.ok) {
        setBody(''); clearImage(); clearAudio()
        setScheduling(false); setSchedDate(''); setSchedTime('09:00')
        setScheduleNotice(`Scheduled for ${fmtFull(sendAt.toISOString())}`)
        fetchScheduled()
      } else {
        const err = await res.json().catch(() => ({}))
        showToast(err.error ?? 'Could not schedule message')
      }
    } catch { showToast('Could not schedule message') }
    finally { setSavingSchedule(false) }
  }

  async function cancelScheduled(scheduledId) {
    if (!selected) return
    if (!window.confirm('Cancel this scheduled message?')) return
    try {
      const token = await getToken()
      const res = await fetch(
        `${API_URL}/api/coach-admin/clients/${selected.clientId}/scheduled-messages/${scheduledId}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        showToast(err.error ?? 'Could not cancel this scheduled message')
      }
      // Resync either way — a 409 means the job delivered it just now, so the
      // list is stale and should drop the row rather than keep offering Cancel.
      fetchScheduled()
    } catch { showToast('Could not cancel this scheduled message') }
  }

  // Delete own message (soft-delete on the server). Confirm first.
  async function deleteMessage(id) {
    if (!selected) return
    if (!window.confirm('Delete this message?')) { setMenuMsgId(null); return }
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${selected.clientId}/messages/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        setMessages(prev => prev.filter(m => m.id !== id))
        fetchInbox()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error ?? 'Could not delete message')
      }
    } catch { alert('Could not delete message') }
    finally { setMenuMsgId(null) }
  }

  const EDIT_WINDOW_MS = 60 * 60 * 1000

  // Client-side UX gate only — the server re-checks the 1-hour window authoritatively.
  function canEditMessage(m) {
    return Date.now() - new Date(m.created_at).getTime() < EDIT_WINDOW_MS
  }

  function startEdit(m) {
    setEditingMsgId(m.id)
    setEditText(m.message_body ?? '')
    setMenuMsgId(null)
  }
  function cancelEdit() {
    setEditingMsgId(null)
    setEditText('')
  }

  async function saveEdit(id) {
    if (!selected) return
    const trimmed = editText.trim()
    if (!trimmed) return
    setSavingEdit(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${selected.clientId}/messages/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_body: trimmed }),
      })
      if (res.ok) {
        const updated = await res.json()
        setMessages(prev => prev.map(m => m.id === id ? { ...m, message_body: updated.message_body, edited_at: updated.edited_at } : m))
        cancelEdit()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error ?? 'Could not edit message')
      }
    } catch { alert('Could not edit message') }
    finally { setSavingEdit(false) }
  }

  function startLongPress(id) {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    longPressTimer.current = setTimeout(() => setMenuMsgId(id), 500)
  }
  function cancelLongPress() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null }
  }

  function startReactLongPress(id) {
    if (reactLongPressTimer.current) clearTimeout(reactLongPressTimer.current)
    reactLongPressTimer.current = setTimeout(() => setReactMsgId(id), 500)
  }
  function cancelReactLongPress() {
    if (reactLongPressTimer.current) { clearTimeout(reactLongPressTimer.current); reactLongPressTimer.current = null }
  }

  // Toggle a reaction on a message (add if not already mine, remove if it is).
  // Optimistic: updates local state immediately, then reconciles with the server response.
  async function toggleReaction(msg, reactionType) {
    if (!selected) return
    if (myId != null && msg.sender_id === myId) return // can't react to your own message
    setReactMsgId(null)
    const mine = (msg.reactions ?? []).some(r => r.reaction_type === reactionType && r.mine)

    setMessages(prev => prev.map(m => {
      if (m.id !== msg.id) return m
      const existing = m.reactions ?? []
      let next
      if (mine) {
        next = existing
          .map(r => r.reaction_type === reactionType ? { ...r, count: r.count - 1, mine: false } : r)
          .filter(r => r.count > 0)
      } else if (existing.some(r => r.reaction_type === reactionType)) {
        next = existing.map(r => r.reaction_type === reactionType ? { ...r, count: r.count + 1, mine: true } : r)
      } else {
        next = [...existing, { reaction_type: reactionType, count: 1, mine: true }]
      }
      return { ...m, reactions: next }
    }))

    try {
      const token = await getToken()
      const base = `${API_URL}/api/coach-admin/clients/${selected.clientId}/messages/${msg.id}/reactions`
      const res = mine
        ? await fetch(`${base}/${reactionType}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        : await fetch(base, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reaction_type: reactionType }),
          })
      if (res.ok) {
        const data = await res.json()
        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, reactions: data.reactions ?? [] } : m))
      }
    } catch { /* optimistic state is a reasonable fallback if the request fails */ }
  }

  // Deselect the current thread and land back at the top of the thread list,
  // instead of wherever it happened to be scrolled to. The actual scroll
  // happens in the useEffect above, once `selected` has cleared and the DOM
  // has genuinely committed — see that effect's comment for why.
  function backToList() {
    backToListPendingRef.current = true
    setSelected(null)
  }

  if (loading) return <p className="text-sm text-gray-400 py-8 text-center">Loading inbox…</p>

  const totalUnread = groupedInbox.reduce((sum, g) => sum + g.totalUnread + g.totalMarkedUnread, 0)

  return (
    <div className="flex flex-col lg:flex-row gap-4 min-h-[600px] relative">
      {toast && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 bg-red-600 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg max-w-sm w-[90vw] text-center">
          {toast.msg}
        </div>
      )}
      {/* Inbox list */}
      <div ref={threadListRef} className={`lg:w-72 shrink-0 flex flex-col overflow-y-auto ${selected ? 'hidden lg:flex' : ''}`}>

        {/* ── Client search / new conversation ─────────────────────────── */}
        <div className="relative mb-2">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8"/><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35"/>
            </svg>
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search clients…"
              className="w-full pl-8 pr-8 py-2 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#E8670A] focus:border-transparent bg-white"
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); setSearchResults([]) }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm leading-none"
                aria-label="Clear search"
              >×</button>
            )}
          </div>

          {/* Search results dropdown */}
          {searchQuery.trim() && (
            <div className="absolute z-20 top-full mt-1 left-0 right-0 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
              {searchLoading && (
                <p className="text-xs text-gray-400 px-3 py-2.5">Searching…</p>
              )}
              {!searchLoading && searchResults.length === 0 && (
                <p className="text-xs text-gray-400 px-3 py-2.5">No clients found.</p>
              )}
              {!searchLoading && searchResults.map(client => (
                <div key={client.id} className="flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-gray-50 border-b border-gray-50 last:border-0">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-800 truncate">{client.full_name}</p>
                    <p className="text-[10px] text-gray-400 truncate">{client.email}</p>
                  </div>
                  <button
                    onClick={() => openClientConversation(client)}
                    className="shrink-0 px-2.5 py-1.5 rounded-lg bg-[#E8670A] text-white text-[11px] font-semibold hover:bg-[#c45e09] transition-colors min-h-[32px]"
                  >
                    Message
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active / Archived tabs */}
        <div className="flex gap-1 mb-2">
          {(['active', 'archived']).map(v => (
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
              onClick={() => setSelected({ clientId: g.client_id, clientName: g.full_name, threadType: g.latestThreadType, isAssignedCoach: g.isAssignedCoach })}
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
                      {myId != null && g.last_sender_id === myId && <span className="opacity-60">You: </span>}
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

      {/* Conversation panel. overflow is visible below md so the sticky header
          (below) can escape to the page's actual scrolling ancestor (Layout's
          <main>) instead of being trapped by this panel's own bounds — at md+
          the panel never needs outer-page scroll, so overflow-hidden (for the
          rounded corners) is restored there. Below md the message list (further
          down) also drops its own internal max-h/scroll so there's exactly one
          scrolling context feeding the sticky header, not two stacked ones —
          the earlier two-scroll-context setup was what made the header visually
          overlap scrolling message content. See the matching md:hidden Back
          to Messages button below, which rounds the bottom corners in the gap
          left by overflow-visible on mobile. */}
      <div className={`flex-1 flex-col bg-white border border-gray-200 rounded-xl overflow-visible md:overflow-hidden ${selected ? 'flex' : 'hidden lg:flex'}`}>
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
            Select a client to view messages
          </div>
        ) : (
          <>
            <div className="sticky top-0 z-10 rounded-t-xl px-4 py-3 border-b border-gray-100 bg-gray-50">
              {/* On iOS/WKWebView, this header only sticks flush with <main>'s padding
                  edge — Layout's <main> reserves pt-[calc(1rem+env(safe-area-inset-top))]
                  above that edge for the notch/status bar, and that reserved strip isn't
                  itself painted by anything, so scrolled-past message bubbles can bleed
                  through it above the header. This filler carries the header's own
                  background up to cover that strip too. It's absolutely positioned (this
                  header is its containing block via position:sticky) so it doesn't add to
                  the header's own box/height at rest — only visible once actually stuck
                  and scrolled, exactly where the gap would otherwise show through.
                  md+ never needs it (panel's own bounded overflow-hidden, no outer-page
                  scroll — see the panel's className comment above). */}
              <div
                aria-hidden="true"
                className="md:hidden absolute inset-x-0 -top-[calc(1rem+env(safe-area-inset-top))] h-[calc(1rem+env(safe-area-inset-top))] bg-gray-50"
              />
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={backToList}
                  className="lg:hidden -ml-1 min-w-10 h-10 flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-200 transition-colors shrink-0"
                  aria-label="Back to inbox"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <Link
                  to={`/admin/clients/${selected.clientId}`}
                  className="text-sm font-semibold text-gray-900 flex-1 min-w-0 break-words hover:underline transition-all"
                >
                  {selected.clientName}
                </Link>
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
              {(() => {
                // Hide admin_private tab when admin is also the assigned coach —
                // avoids two sendable tabs for the same person.
                const visibleThreads = selected?.isAssignedCoach
                  ? availableThreads.filter(t => t.thread_type !== 'admin_private')
                  : availableThreads
                return visibleThreads.length > 1 && (
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {visibleThreads.map(t => {
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
                )
              })()}
            </div>
            {/* Below md, no max-h/internal scroll — the list grows in normal flow so
                the page (Layout's <main>) is the single scrolling ancestor the sticky
                header above anchors to. At md+ the panel is bounded (overflow-hidden,
                see above) so the list scrolls internally within its own 500px cap as
                before. Two independent scroll contexts stacked under one sticky header
                is what caused the header to visually overlap scrolling content — see
                1ea4c4e and the fix that reconciled this. */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 bg-gray-50 space-y-3 md:max-h-[500px]">
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
              {messages.filter(m => !m.deleted_at).map(m => {
                const isStaff = m.sender_role === 'admin' || m.sender_role === 'coach'
                const isMine = myId != null && m.sender_id === myId
                const metadata = parseMessageMetadata(m.metadata)
                return (
                  <div key={m.id} className={`flex ${isStaff ? 'justify-end' : 'justify-start'}`}>
                    <div className={`flex flex-col max-w-[80%] ${isStaff ? 'items-end' : 'items-start'}`}>
                      <div
                        className="group relative flex items-end gap-1 min-w-0 max-w-full"
                        onTouchStart={isMine ? () => startLongPress(m.id) : undefined}
                        onTouchEnd={isMine ? cancelLongPress : undefined}
                        onTouchMove={isMine ? cancelLongPress : undefined}
                      >
                        {isMine && editingMsgId !== m.id && (
                          <button
                            type="button"
                            onClick={() => deleteMessage(m.id)}
                            aria-label="Delete message"
                            title="Delete message"
                            className={`shrink-0 flex items-center justify-center min-w-[44px] min-h-[44px] rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50 transition-opacity ${
                              menuMsgId === m.id
                                ? 'opacity-100 pointer-events-auto'
                                : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
                            }`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                        {isMine && canEditMessage(m) && editingMsgId !== m.id && (
                          <button
                            type="button"
                            onClick={() => startEdit(m)}
                            aria-label="Edit message"
                            title="Edit message"
                            className={`shrink-0 flex items-center justify-center min-w-[44px] min-h-[44px] rounded-full text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-opacity ${
                              menuMsgId === m.id
                                ? 'opacity-100 pointer-events-auto'
                                : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
                            }`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                        )}
                        <div className={`min-w-0 rounded-2xl px-4 py-2 ${
                          isStaff ? 'bg-[#E8670A] text-white' : 'bg-blue-500 text-white'
                        }`}>
                        <p className="text-[10px] font-semibold text-white/70 mb-0.5">
                          {m.sender_name ?? m.sender_role} · {fmtFull(m.created_at)}
                          {m.edited_at && <span className="italic"> · edited</span>}
                        </p>
                        {editingMsgId === m.id ? (
                          <div className="space-y-1.5">
                            <textarea
                              autoFocus
                              value={editText}
                              onChange={e => setEditText(e.target.value)}
                              className="w-full min-w-[200px] text-sm text-gray-800 rounded-lg px-2 py-1.5 bg-white/95"
                              rows={2}
                            />
                            <div className="flex items-center gap-2 justify-end">
                              <button
                                type="button"
                                onClick={cancelEdit}
                                disabled={savingEdit}
                                className="min-h-[44px] px-3 rounded-md text-xs font-semibold text-white/90 hover:bg-white/10 disabled:opacity-40"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => saveEdit(m.id)}
                                disabled={savingEdit || !editText.trim()}
                                className="min-h-[44px] px-3 rounded-md text-xs font-semibold bg-white/90 text-gray-800 hover:bg-white disabled:opacity-40"
                              >
                                {savingEdit ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          m.message_body && <p className="text-sm whitespace-pre-wrap break-words"><LinkifiedText text={m.message_body} /></p>
                        )}
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
                        {/* Can't react to your own message */}
                        {!isMine && (
                          <button
                            type="button"
                            onClick={() => setReactMsgId(id => id === m.id ? null : m.id)}
                            onTouchStart={e => { e.stopPropagation(); startReactLongPress(m.id) }}
                            onTouchEnd={cancelReactLongPress}
                            onTouchMove={cancelReactLongPress}
                            aria-label="React to message"
                            title="React"
                            className="shrink-0 flex items-center justify-center min-w-[44px] min-h-[44px] rounded-full text-gray-300 hover:text-[#E8670A] hover:bg-gray-100 transition-colors"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <circle cx="12" cy="12" r="9" />
                              <path strokeLinecap="round" d="M9 10h.01M15 10h.01" />
                              <path strokeLinecap="round" d="M8.5 14.5a4 4 0 007 0" />
                            </svg>
                          </button>
                        )}
                      </div>
                      {!isMine && reactMsgId === m.id && (
                        <div className="mt-1">
                          <ReactionPicker onPick={type => toggleReaction(m, type)} />
                        </div>
                      )}
                      <ReactionPills reactions={m.reactions} onToggle={type => toggleReaction(m, type)} interactive={!isMine} />
                    </div>
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>
            {/* Read-only notice: admin viewing another coach's thread (not their own) */}
            {role === 'admin' && selected?.threadType === 'coach_thread' && !selected?.isAssignedCoach ? (
              <div className="border-t border-gray-100 px-4 py-3">
                <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  👁 Viewing coach–client thread read-only. Switch to the <strong>{STAFF_THREAD_LABELS['admin_private'] ?? 'Account Owner'}</strong> tab to send your own message.
                </p>
              </div>
            ) : (
            <div className="border-t border-gray-100 p-3 space-y-2">
              {/* Pending scheduled sends for this thread — not yet delivered, so
                  they live outside the message list above until the job runs. */}
              {scheduled.length > 0 && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                    Scheduled ({scheduled.length})
                  </p>
                  {scheduled.map(s => (
                    <div key={s.id} className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-700 truncate">
                          {s.message_body || (s.image_url ? '📷 Photo' : '🎤 Voice message')}
                        </p>
                        <p className="text-[11px] text-gray-400">🕒 {fmtFull(s.send_at)}</p>
                      </div>
                      <button
                        onClick={() => cancelScheduled(s.id)}
                        aria-label="Cancel scheduled message"
                        title="Cancel scheduled message"
                        className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {scheduleNotice && (
                <div className="flex items-start justify-between gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  <p className="text-xs text-green-700">✓ {scheduleNotice}</p>
                  <button onClick={() => setScheduleNotice(null)} className="shrink-0 text-green-400 hover:text-green-600 text-xs font-semibold">✕</button>
                </div>
              )}
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
                  {recordError && recordError !== 'permission_denied' && `Recording error: ${recordError}. Please try again.`}
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
                  <div className="flex flex-col gap-2 shrink-0">
                    <button
                      onClick={send}
                      disabled={sending || uploading || savingSchedule || (!body.trim() && !imgFile && !audioBlob)}
                      className="flex-1 bg-[#E8670A] text-white px-3 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 min-w-[76px] sm:min-w-[88px] min-h-[44px]"
                    >
                      {uploading ? '⬆' : sending ? '…' : 'Send'}
                    </button>
                    <button
                      onClick={() => setScheduling(s => !s)}
                      disabled={sending || uploading || savingSchedule}
                      aria-expanded={scheduling}
                      title="Schedule this message for later"
                      className={`flex-1 px-3 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold border disabled:opacity-40 min-w-[76px] sm:min-w-[88px] min-h-[44px] transition-colors ${
                        scheduling
                          ? 'bg-orange-50 border-[#E8670A] text-[#E8670A]'
                          : 'bg-white border-gray-300 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A]'
                      }`}
                    >
                      🕒 Schedule
                    </button>
                  </div>
                </div>
                {/* Date/time picker — same two-input (date + time) pattern the
                    forms scheduling UI uses, no extra date library. */}
                {scheduling && (
                  <div className="bg-orange-50 border border-orange-200 rounded-lg px-3 py-3 space-y-2">
                    <p className="text-xs font-semibold text-gray-700">Send this message later</p>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="date"
                        value={schedDate}
                        min={localDateInputValue()}
                        onChange={e => setSchedDate(e.target.value)}
                        aria-label="Send date"
                        className="flex-1 min-w-0 min-h-[44px] border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                      />
                      <input
                        type="time"
                        value={schedTime}
                        onChange={e => setSchedTime(e.target.value)}
                        aria-label="Send time"
                        className="flex-1 min-w-0 min-h-[44px] border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={scheduleMessage}
                        disabled={savingSchedule || uploading || !schedDate || !schedTime || (!body.trim() && !imgFile && !audioBlob)}
                        className="bg-[#E8670A] text-white px-4 rounded-lg text-xs sm:text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 min-h-[44px]"
                      >
                        {savingSchedule ? 'Scheduling…' : 'Confirm schedule'}
                      </button>
                      <button
                        onClick={() => setScheduling(false)}
                        className="px-4 rounded-lg text-xs sm:text-sm font-semibold text-gray-600 border border-gray-300 bg-white hover:border-gray-400 min-h-[44px]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button onClick={capturePhoto} disabled={!!audioBlob || recording} title="Take photo" className="shrink-0 min-w-[44px] h-[44px] px-2.5 flex items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A] disabled:opacity-30 transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  </button>
                  <button onClick={() => galleryInputRef.current?.click()} disabled={!!audioBlob || recording} title="Choose from gallery" className="shrink-0 min-w-[44px] h-[44px] px-2.5 flex items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A] disabled:opacity-30 transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  </button>
                  <button
                    onClick={recording ? stopRecording : startRecording}
                    disabled={!!imgFile}
                    title={!canRecord ? 'Voice recording not supported in this browser' : recording ? 'Stop recording' : 'Record voice message'}
                    className={`shrink-0 min-w-[44px] h-[44px] px-2.5 flex items-center justify-center rounded-lg border transition-colors disabled:opacity-30 ${
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

            {/* Back to Messages — mobile only, sits below the compose area so it's
                the last thing on screen when scrolled to the bottom of the thread.
                Desktop always shows the thread list alongside, so no back button there.
                rounded-b-xl covers the bottom corners while the panel above is
                overflow-visible (below md) — see the panel's className comment. */}
            <button
              onClick={backToList}
              className="md:hidden shrink-0 w-full py-3 text-xs font-medium text-gray-400 hover:text-gray-600 border-t border-gray-100 bg-white rounded-b-xl transition-colors min-h-[44px]"
            >
              ← Back to Messages
            </button>
          </>
        )}
      </div>
    </div>
  )
}
