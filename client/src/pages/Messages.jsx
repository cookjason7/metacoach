import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@clerk/clerk-react'
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { Capacitor } from '@capacitor/core'
import { API_URL } from '../config.js'
import StaffInbox from '../components/StaffInbox.jsx'
import LinkifiedText from '../components/LinkifiedText.jsx'
import { useVoiceRecorder } from '../hooks/useVoiceRecorder.js'
import { useViewMode } from '../context/ViewModeContext.jsx'

// Only these three thread types are shown to clients.
// ai_coach, proactive_ai, and any other automated threads are intentionally excluded.
const HUMAN_THREAD_TYPES = ['admin_private', 'coach_thread', 'ai_admin']

function getThreadMeta(threadType, coachName, isSupportClient = false) {
  if (threadType === 'admin_private') return { title: 'Jason Cook',              icon: '💬', subtitle: 'Messages with Jason Cook',                 canReply: true }
  if (threadType === 'coach_thread')  return isSupportClient
    ? { title: 'Support', icon: '💬', subtitle: 'Messages from the support team', canReply: true }
    : { title: coachName || 'Your Coach', icon: '💬', subtitle: `Messages with ${coachName || 'your coach'}`, canReply: true }
  if (threadType === 'ai_admin')      return {
    title:    isSupportClient ? 'Support'    : 'Your Team',
    icon:     '💬',
    subtitle: isSupportClient ? 'Send a message to the support team' : 'Messages from your coaching team',
    canReply: true,
  }
  return { title: threadType, icon: '💬', subtitle: '', canReply: true }
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const yest = new Date(now); yest.setDate(yest.getDate() - 1)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const sameYear = d.getFullYear() === now.getFullYear()
  const dateStr = d.toLocaleDateString([], sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
  if (d.toDateString() === now.toDateString()) return `Today ${time}`
  if (d.toDateString() === yest.toDateString()) return `Yesterday ${time}`
  return `${dateStr} ${time}`
}

function fmtShort(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const yest = new Date(now); yest.setDate(yest.getDate() - 1)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const sameYear = d.getFullYear() === now.getFullYear()
  const dateStr = d.toLocaleDateString([], sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
  if (d.toDateString() === now.toDateString()) return `Today ${time}`
  if (d.toDateString() === yest.toDateString()) return 'Yesterday'
  return dateStr
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
      isMine ? 'bg-white/20 text-white' : 'bg-white/95 text-gray-800'
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
      <span className="w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums text-gray-500">
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

export default function Messages() {
  const { getToken } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const { viewing, viewedClient } = useViewMode()
  const [deepLinkClientId, setDeepLinkClientId] = useState(null)
  const [isStaff,     setIsStaff]     = useState(null) // null = loading
  const [staffRole,   setStaffRole]   = useState(null) // 'admin' | 'coach' | null
  const [coachingType, setCoachingType] = useState(null) // 'vip' | 'hybrid' | 'basic' (legacy: 'ai' ≡ 'hybrid') | null
  const [threads,     setThreads]     = useState([])
  const [coachName,   setCoachName]   = useState(null)
  const [active,      setActive]      = useState(null)  // thread_type string
  const [messages,      setMessages]      = useState([])
  const [hasMore,       setHasMore]       = useState(false)
  const [nextBeforeId,  setNextBeforeId]  = useState(null)
  const [loadingOlder,  setLoadingOlder]  = useState(false)
  const [body,        setBody]        = useState('')
  const [loading,     setLoading]     = useState(true)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [sending,     setSending]     = useState(false)
  const scrollRef      = useRef(null)
  const bottomRef      = useRef(null) // sentinel after the last message — scrollIntoView works regardless of which ancestor is the actual scrolling container (this panel's own overflow-y-auto, or the page itself on mobile)
  const msgCountRef    = useRef(0)
  const didPrependRef  = useRef(false)
  const didAutoOpenRef = useRef(false)
  const fileInputRef   = useRef(null)  // camera
  const galleryInputRef = useRef(null) // gallery/files
  const [imgPreview, setImgPreview] = useState(null) // object URL for preview
  const [imgFile,    setImgFile]    = useState(null) // File object
  const [uploading,  setUploading]  = useState(false)
  const [menuMsgId,  setMenuMsgId]  = useState(null) // message id with delete affordance revealed (mobile long-press)
  const [reactMsgId, setReactMsgId] = useState(null) // message id with reaction picker open
  const [editingMsgId, setEditingMsgId] = useState(null) // message id currently being edited
  const [editText,     setEditText]     = useState('')
  const [savingEdit,   setSavingEdit]   = useState(false)
  const longPressTimer = useRef(null)
  const reactLongPressTimer = useRef(null)

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

  // Deep link from a message push notification: /messages?client_id=USER_ID
  // (see notifyNewDirectMessage in server/services/pushService.js and the
  // pushNotificationActionPerformed listener in Layout.jsx). Runs on every
  // navigation, not just first mount, so tapping a second notification while
  // already on this page still jumps to the new sender's thread.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const clientId = params.get('client_id')
    if (clientId) {
      setDeepLinkClientId(Number(clientId))
      // replace (not push) so the back button doesn't retrace through the param
      window.history.replaceState({}, '', '/messages')
    }
  }, [location])

  // Detect role once on mount. While viewing is true, force the client thread
  // view (StaffInbox is a staff-only tool, not part of the client experience) —
  // coachingType comes from the viewedClient snapshot since /api/users/me is
  // never view-as aware and would otherwise return the staff member's own row.
  useEffect(() => {
    async function checkRole() {
      if (viewing) {
        setIsStaff(false)
        setStaffRole(null)
        setCoachingType(viewedClient?.coaching_type ?? 'vip')
        return
      }
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const data = await res.json()
          setIsStaff(data.role === 'admin' || data.role === 'account_owner' || data.role === 'coach' || data.role === 'staff')
          setStaffRole(data.role ?? null)
          setCoachingType(data.coaching_type ?? 'vip')
        } else {
          setIsStaff(false)
        }
      } catch { setIsStaff(false) }
    }
    checkRole()
  }, [getToken, viewing, viewedClient])

  const loadThreads = useCallback(async () => {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/messages/threads`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      const data = await res.json()
      const raw    = Array.isArray(data) ? data : (data.threads ?? [])
      const coach  = Array.isArray(data) ? null : (data.coachName ?? null)

      // Keep only human/team threads; deduplicate by type (first wins per type)
      const seen = new Set()
      const list = raw.filter(t => {
        if (!HUMAN_THREAD_TYPES.includes(t.thread_type)) return false
        if (seen.has(t.thread_type)) return false
        seen.add(t.thread_type)
        return true
      })
      // Sort by our preferred order: Jason → coach → team
      list.sort((a, b) =>
        HUMAN_THREAD_TYPES.indexOf(a.thread_type) - HUMAN_THREAD_TYPES.indexOf(b.thread_type),
      )

      setThreads(list)
      setCoachName(coach)
      // Auto-open the most recently active thread on first load only
      // (ensures a newly-sent form message thread opens, not always admin_private)
      setActive(prev => {
        if (didAutoOpenRef.current || prev || list.length === 0) return prev
        didAutoOpenRef.current = true
        const byRecent = [...list].sort(
          (a, b) => new Date(b.last_message_at ?? 0) - new Date(a.last_message_at ?? 0),
        )
        return byRecent[0].thread_type
      })
    }
    setLoading(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken])

  useEffect(() => { loadThreads() }, [loadThreads])

  useEffect(() => {
    const id = setInterval(loadThreads, 30_000)
    return () => clearInterval(id)
  }, [loadThreads])

  const loadMessages = useCallback(async () => {
    if (!active) return
    setLoadingMsgs(true)
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/messages/thread/${active}?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      const data = await res.json()
      const msgs = data.messages ?? []
      setMessages(msgs)
      setHasMore(data.hasMore ?? false)
      setNextBeforeId(data.nextBeforeId ?? null)
      msgCountRef.current = msgs.length
    }
    setLoadingMsgs(false)
  }, [active, getToken])

  const loadOlder = useCallback(async () => {
    if (!active || !nextBeforeId || loadingOlder) return
    setLoadingOlder(true)
    try {
      const token = await getToken()
      const res = await fetch(
        `${API_URL}/api/messages/thread/${active}?limit=50&before_id=${nextBeforeId}`,
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
  }, [active, nextBeforeId, loadingOlder, getToken])

  useEffect(() => { loadMessages() }, [loadMessages])

  // Close any open reaction picker / delete affordance when switching threads
  useEffect(() => { setReactMsgId(null); setMenuMsgId(null) }, [active])

  useEffect(() => {
    if (!active) return
    const poll = async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/messages/thread/${active}?limit=50`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const data = await res.json()
        const fresh = data.messages ?? []
        setMessages(prev => {
          const ids = new Set(prev.map(m => m.id))
          const newOnes = fresh.filter(m => !ids.has(m.id))
          if (newOnes.length === 0) return prev
          const merged = [...prev, ...newOnes]
          merged.sort((a, b) => a.id - b.id)
          msgCountRef.current = merged.length
          return merged
        })
        setHasMore(data.hasMore ?? false)
        setNextBeforeId(data.nextBeforeId ?? null)
        loadThreads()
      } catch {}
    }
    const id = setInterval(poll, 20_000)
    return () => clearInterval(id)
  }, [active, getToken, loadThreads])

  useEffect(() => {
    if (didPrependRef.current) { didPrependRef.current = false; return }
    if (messages.length > 0 && messages.length >= msgCountRef.current) {
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
      const res = await fetch(`${API_URL}/api/messages/thread/${active}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_body: body, image_url, audio_url }),
      })
      if (res.ok) {
        const msg = await res.json()
        setMessages(m => [...m, msg])
        setBody(''); clearImage(); clearAudio()
        loadThreads()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error ?? 'Could not send message')
      }
    } catch { alert('Could not send message') }
    finally { setSending(false) }
  }

  // Delete own message (soft-delete on the server). Confirm first.
  async function deleteMessage(id) {
    if (!window.confirm('Delete this message?')) { setMenuMsgId(null); return }
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/messages/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        setMessages(prev => prev.filter(m => m.id !== id))
        loadThreads()
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
    const trimmed = editText.trim()
    if (!trimmed) return
    setSavingEdit(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/messages/${id}`, {
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
    if (viewing) return // read-only — no delete/edit affordance while viewing as a client
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    longPressTimer.current = setTimeout(() => setMenuMsgId(id), 500)
  }
  function cancelLongPress() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null }
  }

  function startReactLongPress(id) {
    if (viewing) return // read-only — no reaction picker while viewing as a client
    if (reactLongPressTimer.current) clearTimeout(reactLongPressTimer.current)
    reactLongPressTimer.current = setTimeout(() => setReactMsgId(id), 500)
  }
  function cancelReactLongPress() {
    if (reactLongPressTimer.current) { clearTimeout(reactLongPressTimer.current); reactLongPressTimer.current = null }
  }

  // Toggle a reaction on a message (add if not already mine, remove if it is).
  // Optimistic: updates local state immediately, then reconciles with the server response.
  async function toggleReaction(msg, reactionType) {
    if (msg.sender_role === 'client') return // can't react to your own message
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
      const res = mine
        ? await fetch(`${API_URL}/api/messages/${msg.id}/reactions/${reactionType}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
          })
        : await fetch(`${API_URL}/api/messages/${msg.id}/reactions`, {
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

  // ── Staff/admin: show client inbox ────────────────────────────────────────
  if (isStaff === null) return <p className="text-sm text-gray-400 py-12 text-center">Loading…</p>
  if (isStaff) {
    return (
      <div className="max-w-5xl">
        <div className="mb-5">
          <h1 className="text-2xl font-bold text-gray-900">Messages</h1>
          <p className="text-sm text-gray-500">Client inbox — reply to any conversation below.</p>
        </div>
        <StaffInbox getToken={getToken} role={staffRole} focusClientId={deepLinkClientId} />
      </div>
    )
  }

  // ── Client UI ─────────────────────────────────────────────────────────────
  const isSupportClient = !isStaff && coachingType !== null && coachingType !== 'vip'
  const activeMeta  = active ? getThreadMeta(active, coachName, isSupportClient) : null
  const displayMeta = activeMeta

  return (
    <div className="max-w-5xl">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">
          {isSupportClient ? 'Support' : 'Messages'}
        </h1>
        <p className="text-sm text-gray-500">
          {isSupportClient
            ? 'Message support. We’ll get back to you soon.'
            : 'Chat with your coach and the team.'}
        </p>
      </div>

      {loading && <p className="text-center text-gray-400 py-12 text-sm">Loading messages…</p>}

      {!loading && threads.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-4xl mb-3">💬</p>
          <p className="text-sm text-gray-500 mb-1">No messages yet.</p>
          <p className="text-xs text-gray-400">
            {isSupportClient
              ? 'A support thread will appear here once your coach or team reaches out.'
              : 'Your coach will reach out soon. Check back here for updates.'}
          </p>
        </div>
      )}

      {!loading && threads.length > 0 && (
        <div className="flex gap-4 min-h-[calc(100vh-13rem)] lg:min-h-[500px]">

          {/* Thread list — hidden on mobile when a conversation is open */}
          <div className={`lg:w-64 shrink-0 space-y-1.5 ${active ? 'hidden lg:block' : 'w-full lg:w-64'}`}>
            {threads.map(t => {
              const meta     = getThreadMeta(t.thread_type, coachName, isSupportClient)
              const isActive = active === t.thread_type
              const hasUnread = Number(t.unread) > 0
              return (
                <button
                  key={t.thread_type}
                  onClick={() => setActive(t.thread_type)}
                  className={`w-full text-left border rounded-xl px-3 py-3 transition-all ${
                    isActive
                      ? 'bg-[#E8670A] border-[#E8670A] text-white shadow-md'
                      : hasUnread
                        ? 'bg-orange-50 border-orange-200 hover:border-[#E8670A]'
                        : 'bg-white border-gray-200 hover:border-[#E8670A]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <p className={`text-sm font-semibold flex items-center gap-1.5 ${isActive ? 'text-white' : 'text-gray-900'}`}>
                          <span>{meta.icon}</span>{meta.title}
                        </p>
                        {t.last_message_at && (
                          <span className={`text-[10px] shrink-0 ${isActive ? 'text-white/70' : 'text-gray-400'}`}>
                            {fmtShort(t.last_message_at)}
                          </span>
                        )}
                      </div>
                      <p className={`text-[10px] mt-0.5 ${isActive ? 'text-white/80' : 'text-gray-400'}`}>
                        {meta.subtitle}
                      </p>
                      {t.last_message_body && (
                        <p className={`text-xs mt-1 truncate ${isActive ? 'text-white/80' : hasUnread ? 'text-gray-800 font-medium' : 'text-gray-500'}`}>
                          {t.last_message_body}
                        </p>
                      )}
                    </div>
                    {hasUnread && !isActive && (
                      <span className="bg-[#E8670A] text-white text-[10px] font-bold rounded-full px-2 py-0.5 shrink-0">
                        {t.unread}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Conversation pane — full-width on mobile when active */}
          <div className={`flex-1 min-w-0 flex-col bg-white border border-gray-200 rounded-xl overflow-hidden ${active ? 'flex' : 'hidden lg:flex'}`}>
            {active && displayMeta ? (
              <>
                {/* Header */}
                <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-3">
                  {/* Back button — mobile only */}
                  <button
                    onClick={() => setActive(null)}
                    className="lg:hidden -ml-1 p-1.5 rounded-lg text-gray-500 hover:bg-gray-200 transition-colors shrink-0"
                    aria-label="Back to threads"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <div>
                    <p className="text-sm font-semibold text-gray-900">
                      {displayMeta.icon} {displayMeta.title}
                    </p>
                    {!displayMeta.canReply && (
                      <p className="text-[10px] text-amber-700 mt-0.5">
                        🔒 One-way thread — you cannot reply here.
                      </p>
                    )}
                  </div>
                </div>

                {/* Messages */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 sm:p-4 bg-gray-50 space-y-3 max-h-[calc(100vh-23rem)] lg:max-h-[500px]">
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
                    <p className="text-center text-xs text-gray-400 py-8">No messages yet in this thread.</p>
                  )}
                  {messages.filter(m => !m.deleted_at).map(m => {
                    const isMe = m.sender_role === 'client'
                    const metadata = parseMessageMetadata(m.metadata)
                    const isWeeklyCheckIn = /weekly\s+check[-\s]?in/i.test(metadata.form_title ?? '')
                    const formHref = metadata.form_id
                      ? `/forms/${metadata.form_id}/fill${metadata.assignment_id ? `?assignment_id=${metadata.assignment_id}` : ''}`
                      : null
                    return (
                      <div key={m.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                        <div className={`flex flex-col max-w-[88%] sm:max-w-[80%] ${isMe ? 'items-end' : 'items-start'}`}>
                          <div
                            className="group relative flex items-end gap-1 min-w-0 max-w-full"
                            onTouchStart={isMe ? () => startLongPress(m.id) : undefined}
                            onTouchEnd={isMe ? cancelLongPress : undefined}
                            onTouchMove={isMe ? cancelLongPress : undefined}
                          >
                            {isMe && editingMsgId !== m.id && (
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
                            {isMe && canEditMessage(m) && editingMsgId !== m.id && (
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
                              isMe ? 'bg-blue-500 text-white' : 'bg-[#E8670A] text-white'
                            }`}>
                            <p className="text-[10px] font-semibold mb-0.5 text-white/80">
                              {isMe ? 'You' : (m.sender_name ?? m.sender_role)} · {fmtTime(m.created_at)}
                              {m.edited_at && <span className="italic"> · edited</span>}
                            </p>
                            {editingMsgId === m.id ? (
                              <div className="space-y-1.5">
                                <textarea
                                  autoFocus
                                  value={editText}
                                  onChange={e => setEditText(e.target.value)}
                                  className="w-full min-w-[200px] text-base sm:text-sm text-gray-800 rounded-lg px-2 py-1.5 bg-white/95"
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
                              <VoiceMessagePlayer audioUrl={m.audio_url} isMine={isMe} />
                            )}
                            {!isMe && formHref && (
                              <a
                                href={formHref}
                                className="mt-2 flex items-center gap-1.5 bg-white text-[#E8670A] hover:bg-orange-50 rounded-lg px-3 py-2 text-xs font-bold transition-colors min-h-[44px]"
                              >
                                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                                </svg>
                                {isWeeklyCheckIn ? 'Open Check-In' : 'Complete Form'}
                              </a>
                            )}
                            </div>
                            {/* Can't react to your own message */}
                            {!isMe && !viewing && (
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
                          {!isMe && reactMsgId === m.id && (
                            <div className="mt-1">
                              <ReactionPicker onPick={type => toggleReaction(m, type)} />
                            </div>
                          )}
                          <ReactionPills reactions={m.reactions} onToggle={type => toggleReaction(m, type)} interactive={!isMe} />
                        </div>
                      </div>
                    )
                  })}
                  <div ref={bottomRef} />
                </div>

                {/* Reply box — hidden while viewing, not just disabled: server-side
                    blockWritesInViewMode already 403s any of these, but showing the
                    composer at all would invite a failed-request error instead of a
                    clean read-only view. */}
                {displayMeta.canReply && !viewing && (
                  <div className="border-t border-gray-100 p-3 space-y-2">
                    {/* Image preview */}
                    {imgPreview && (
                      <div className="relative inline-block">
                        <img src={imgPreview} alt="preview" className="max-h-28 rounded-lg border border-gray-200" />
                        <button onClick={clearImage} className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center leading-none font-bold">×</button>
                      </div>
                    )}
                    {/* Audio preview */}
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
                    {/* Recording indicator */}
                    {recording && (
                      <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                        <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-xs text-red-600 font-medium">Recording… tap ■ to stop</span>
                      </div>
                    )}
                    {/* Record error */}
                    {recordError && (
                      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        {recordError === 'not_supported' && 'Voice recording is not supported in this browser.'}
                        {recordError === 'permission_denied' && 'Microphone access was denied. Please allow microphone access and try again.'}
                        {recordError && recordError !== 'permission_denied' && `Recording error: ${recordError}. Please try again.`}
                      </p>
                    )}
                    <div className="space-y-2 pb-[env(safe-area-inset-bottom)]">
                      {/* Camera input */}
                      <input ref={fileInputRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" capture="environment" className="hidden" onChange={handleFileSelect} />
                      {/* Gallery input */}
                      <input ref={galleryInputRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" className="hidden" onChange={handleFileSelect} />
                      <div className="flex items-end gap-2">
                        <textarea
                          value={body}
                          onChange={e => setBody(e.target.value)}
                          placeholder="Type a message…"
                          rows={3}
                          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                          className="flex-1 min-w-0 min-h-[84px] max-h-36 border border-gray-300 rounded-lg px-3 py-2 text-base sm:text-sm leading-5 focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none overflow-y-auto"
                        />
                        <button
                          onClick={send}
                          disabled={sending || uploading || (!body.trim() && !imgFile && !audioBlob)}
                          className="bg-[#E8670A] text-white px-3 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 min-w-[64px] sm:min-w-[76px] min-h-[44px]"
                        >
                          {uploading ? '⬆' : sending ? '…' : 'Send'}
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Camera button */}
                        <button onClick={capturePhoto} disabled={!!audioBlob || recording} title="Take photo" className="shrink-0 min-w-[44px] h-[44px] px-2.5 flex items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A] disabled:opacity-30 transition-colors">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        </button>
                        {/* Gallery button */}
                        <button onClick={() => galleryInputRef.current?.click()} disabled={!!audioBlob || recording} title="Choose from gallery" className="shrink-0 min-w-[44px] h-[44px] px-2.5 flex items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A] disabled:opacity-30 transition-colors">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                        </button>
                        {/* Mic / Stop button */}
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
                )}

                {/* Back — mobile only, returns to whatever screen the client actually came
                    from (bottom nav, a notification deep-link, a "Message your coach" button
                    elsewhere, etc.), not a hardcoded destination. Matches StaffInbox.jsx's
                    "Back to Messages" button position (below the reply box). Desktop always
                    shows the thread list alongside plus the persistent sidebar nav, so — same
                    as StaffInbox's own md:hidden/lg:hidden back controls — there's no need for
                    an in-content back control there. */}
                <button
                  onClick={() => navigate(-1)}
                  className="md:hidden shrink-0 w-full py-3 text-xs font-medium text-gray-400 hover:text-gray-600 border-t border-gray-100 bg-white transition-colors min-h-[44px]"
                >
                  ← Back
                </button>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
                Select a thread to view messages
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
