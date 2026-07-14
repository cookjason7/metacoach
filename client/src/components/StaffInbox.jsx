import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
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
  const [myId,        setMyId]        = useState(null) // current staff user's db id — identifies own messages
  const [menuMsgId,   setMenuMsgId]   = useState(null) // message id with delete affordance revealed (mobile long-press)
  const longPressTimer = useRef(null)

  const [inboxView, setInboxView] = useState('active') // 'active' | 'archived'
  const [availableThreads, setAvailableThreads] = useState([]) // thread types for current client (ignores archive state)
  const [actionError, setActionError] = useState(null) // surfaced when archive/unarchive/mark-unread fails

  // ── Client search (compose new conversation) ──────────────────────────────
  const [searchQuery,   setSearchQuery]   = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const searchRef = useRef(null) // input ref for focus management

  // ── Bulk broadcast (New Broadcast modal) ──────────────────────────────────
  const [showBroadcast,          setShowBroadcast]          = useState(false)
  const [broadcastClients,       setBroadcastClients]       = useState([])
  const [broadcastClientsLoaded, setBroadcastClientsLoaded] = useState(false)
  const [broadcastLoading,       setBroadcastLoading]       = useState(false)
  const [broadcastSearch,        setBroadcastSearch]        = useState('')
  const [broadcastSelected,      setBroadcastSelected]       = useState(() => new Set())
  const [broadcastBody,          setBroadcastBody]          = useState('')
  const [broadcastSending,       setBroadcastSending]       = useState(false)
  const [broadcastError,         setBroadcastError]         = useState(null)
  const [broadcastToast,         setBroadcastToast]         = useState(null)

  const canBroadcast = role === 'admin' || role === 'account_owner' || role === 'coach'

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
  // Throws on any failure (network error or non-2xx response) instead of swallowing it,
  // so callers that need to confirm success (archive/unarchive/mark-unread) can tell
  // the difference between "done" and "silently failed" and surface it to the user.
  async function patchInboxState(clientId, threadType, patch) {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/messaging/states/${clientId}/${threadType}`, {
      method:  'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
    })
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}))
      throw new Error(error || `Request failed (${res.status})`)
    }
  }

  async function archiveConversation() {
    if (!selected) return
    setActionError(null)
    try {
      await patchInboxState(selected.clientId, selected.threadType, { archived: true })
      selectedRef.current = null
      setSelected(null)
      await fetchInbox()
    } catch (err) {
      setActionError(`Couldn't archive this conversation: ${err.message}`)
    }
  }

  async function unarchiveConversation() {
    if (!selected) return
    setActionError(null)
    try {
      await patchInboxState(selected.clientId, selected.threadType, { archived: false })
      selectedRef.current = null
      setSelected(null)
      await fetchInbox()
    } catch (err) {
      setActionError(`Couldn't restore this conversation: ${err.message}`)
    }
  }

  async function markUnread() {
    if (!selected) return
    setActionError(null)
    try {
      await patchInboxState(selected.clientId, selected.threadType, { marked_unread: true })
      selectedRef.current = null
      setSelected(null)
      await fetchInbox()
    } catch (err) {
      setActionError(`Couldn't mark this conversation unread: ${err.message}`)
    }
  }

  // Reset inboxView back to active & clear selection when switching tabs
  function switchView(view) {
    setInboxView(view)
    setSelected(null)
  }

  useEffect(() => { selectedRef.current = selected }, [selected])

  // Jump to a client's thread when focusClientId is set (dashboard "Message" quick
  // action, or a message push notification deep link via Messages.jsx). Depends on
  // focusClientId itself (not just running once on mount) so a second deep link
  // while this component is already mounted still re-selects.
  useEffect(() => {
    if (focusClientId == null) return
    const threadType = (role === 'admin' || role === 'account_owner') ? 'admin_private' : 'coach_thread'
    setSelected(prev =>
      prev?.clientId === focusClientId
        ? prev
        : { clientId: focusClientId, clientName: focusClientName, threadType, isAssignedCoach: false },
    )
  }, [focusClientId, focusClientName, role])

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
          isAssignedCoach:    row.is_assigned_coach === true,
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
    // When the logged-in admin IS the assigned coach, default to coach_thread so
    // clicking the client card doesn't open the admin_private (Jason) thread first.
    for (const g of map.values()) {
      if (g.isAssignedCoach && g.threads.some(t => t.thread_type === 'coach_thread')) {
        g.latestThreadType = 'coach_thread'
      }
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

  // Fill in the client's display name once the inbox loads, for deep links that
  // arrive with only a client id (push notifications don't carry a name).
  useEffect(() => {
    if (!selected || selected.clientName) return
    const match = groupedInbox.find(g => g.client_id === selected.clientId)
    if (match) setSelected(s => (s ? { ...s, clientName: match.full_name } : s))
  }, [selected, groupedInbox])

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

  // ── Bulk broadcast ────────────────────────────────────────────────────────
  async function loadBroadcastClients() {
    setBroadcastLoading(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients?status=active`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setBroadcastClients(await res.json())
    } catch {}
    finally { setBroadcastLoading(false); setBroadcastClientsLoaded(true) }
  }

  function openBroadcast() {
    setShowBroadcast(true)
    setBroadcastError(null)
    if (!broadcastClientsLoaded) loadBroadcastClients()
  }

  function closeBroadcast() {
    setShowBroadcast(false)
    setBroadcastSearch('')
    setBroadcastSelected(new Set())
    setBroadcastBody('')
    setBroadcastError(null)
  }

  const filteredBroadcastClients = useMemo(() => {
    const q = broadcastSearch.trim().toLowerCase()
    if (!q) return broadcastClients
    return broadcastClients.filter(c => {
      const name = `${c.first_name ?? ''} ${c.display_last_name ?? ''}`.toLowerCase()
      return name.includes(q) || (c.email ?? '').toLowerCase().includes(q)
    })
  }, [broadcastClients, broadcastSearch])

  const allFilteredSelected = filteredBroadcastClients.length > 0
    && filteredBroadcastClients.every(c => broadcastSelected.has(c.id))

  function toggleBroadcastClient(id) {
    setBroadcastSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleSelectAllBroadcast() {
    setBroadcastSelected(prev => {
      const next = new Set(prev)
      if (allFilteredSelected) filteredBroadcastClients.forEach(c => next.delete(c.id))
      else filteredBroadcastClients.forEach(c => next.add(c.id))
      return next
    })
  }

  async function sendBroadcast() {
    if (broadcastSelected.size === 0 || !broadcastBody.trim() || broadcastSending) return
    setBroadcastSending(true)
    setBroadcastError(null)
    try {
      const token = await getToken()
      const threadType = (role === 'admin' || role === 'account_owner') ? 'admin_private' : 'coach_thread'
      const res = await fetch(`${API_URL}/api/coach-admin/messages/bulk`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          client_ids:   [...broadcastSelected],
          message_body: broadcastBody,
          thread_type:  threadType,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        closeBroadcast()
        setBroadcastToast(`Sent to ${data.sent} client${data.sent === 1 ? '' : 's'}${data.failed?.length ? ` (${data.failed.length} failed)` : ''}`)
        setTimeout(() => setBroadcastToast(null), 4000)
        fetchInbox()
      } else {
        const err = await res.json().catch(() => ({}))
        setBroadcastError(err.error ?? 'Could not send broadcast')
      }
    } catch {
      setBroadcastError('Could not send broadcast')
    } finally {
      setBroadcastSending(false)
    }
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

  function startLongPress(id) {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    longPressTimer.current = setTimeout(() => setMenuMsgId(id), 500)
  }
  function cancelLongPress() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null }
  }

  if (loading) return <p className="text-sm text-gray-400 py-8 text-center">Loading inbox…</p>

  const totalUnread = groupedInbox.reduce((sum, g) => sum + g.totalUnread + g.totalMarkedUnread, 0)

  return (
    <div className="flex flex-col lg:flex-row gap-4 min-h-[600px]">
      {/* Inbox list */}
      <div className={`lg:w-72 shrink-0 flex flex-col overflow-y-auto ${selected ? 'hidden lg:flex' : ''}`}>

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

        {/* New Broadcast — bulk message to many clients at once */}
        {canBroadcast && (
          <button
            onClick={openBroadcast}
            className="w-full mb-2 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-[#E8670A] bg-orange-50 border border-orange-200 hover:bg-orange-100 transition-colors min-h-[40px]"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            New Broadcast
          </button>
        )}

        {/* Toast — bulk send confirmation */}
        {broadcastToast && (
          <div className="mb-2 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-[#1e2a3a] text-center">
            {broadcastToast}
          </div>
        )}

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
              {actionError && (
                <div className="mt-2 flex items-start justify-between gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <p className="text-xs text-red-700">{actionError}</p>
                  <button onClick={() => setActionError(null)} className="shrink-0 text-red-400 hover:text-red-600 text-xs font-semibold">✕</button>
                </div>
              )}
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
              {messages.filter(m => !m.deleted_at).map(m => {
                const isStaff = m.sender_role === 'admin' || m.sender_role === 'coach'
                const isMine = myId != null && m.sender_id === myId
                const metadata = parseMessageMetadata(m.metadata)
                return (
                  <div key={m.id} className={`flex ${isStaff ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className="group relative flex items-end gap-1 max-w-[80%]"
                      onTouchStart={isMine ? () => startLongPress(m.id) : undefined}
                      onTouchEnd={isMine ? cancelLongPress : undefined}
                      onTouchMove={isMine ? cancelLongPress : undefined}
                      onContextMenu={isMine ? e => { e.preventDefault(); setMenuMsgId(m.id) } : undefined}
                    >
                      {isMine && (
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
                      <div className={`min-w-0 rounded-2xl px-4 py-2 ${
                        isStaff ? 'bg-[#E8670A] text-white' : 'bg-blue-500 text-white'
                      }`}>
                      <p className="text-[10px] font-semibold text-white/70 mb-0.5">
                        {m.sender_name ?? m.sender_role} · {fmtFull(m.created_at)}
                      </p>
                      {m.message_body && <p className="text-sm whitespace-pre-wrap"><LinkifiedText text={m.message_body} /></p>}
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
                  </div>
                )
              })}
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
                  <button
                    onClick={send}
                    disabled={sending || uploading || (!body.trim() && !imgFile && !audioBlob)}
                    className="bg-[#E8670A] text-white px-3 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 min-w-[64px] sm:min-w-[76px] min-h-[44px]"
                  >
                    {uploading ? '⬆' : sending ? '…' : 'Send'}
                  </button>
                </div>
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
                Desktop always shows the thread list alongside, so no back button there. */}
            <button
              onClick={() => setSelected(null)}
              className="md:hidden shrink-0 w-full py-3 text-xs font-medium text-gray-400 hover:text-gray-600 border-t border-gray-100 bg-white transition-colors min-h-[44px]"
            >
              ← Back to Messages
            </button>
          </>
        )}
      </div>

      {/* ── New Broadcast modal ─────────────────────────────────────────── */}
      {showBroadcast && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
          <div className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col max-h-[92vh] sm:max-h-[85vh]">
            {/* Header */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
              <h2 className="text-sm font-bold text-gray-900">New Broadcast</h2>
              <button
                onClick={closeBroadcast}
                aria-label="Close"
                className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors text-lg leading-none"
              >
                ×
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {broadcastError && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {broadcastError}
                </p>
              )}

              {/* Client search */}
              <input
                type="text"
                value={broadcastSearch}
                onChange={e => setBroadcastSearch(e.target.value)}
                placeholder="Search clients…"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#E8670A] focus:border-transparent"
              />

              {/* Select all */}
              <label className="flex items-center gap-2 px-1 py-1 text-xs font-semibold text-gray-600 select-none">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleSelectAllBroadcast}
                  className="w-4 h-4 accent-[#E8670A]"
                />
                Select all{broadcastSearch.trim() ? ' (matching)' : ''}
              </label>

              {/* Checkbox client list */}
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-64 overflow-y-auto">
                {broadcastLoading && (
                  <p className="text-xs text-gray-400 text-center py-6">Loading clients…</p>
                )}
                {!broadcastLoading && filteredBroadcastClients.length === 0 && (
                  <p className="text-xs text-gray-400 text-center py-6">No clients found.</p>
                )}
                {!broadcastLoading && filteredBroadcastClients.map(client => {
                  const name = `${client.first_name ?? ''} ${client.display_last_name ?? ''}`.trim() || client.email || 'Client'
                  return (
                    <label
                      key={client.id}
                      className="flex items-center gap-2 px-3 py-2.5 min-h-[44px] hover:bg-gray-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={broadcastSelected.has(client.id)}
                        onChange={() => toggleBroadcastClient(client.id)}
                        className="w-4 h-4 accent-[#E8670A] shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold text-gray-800 truncate">{name}</span>
                        <span className="block text-[10px] text-gray-400 truncate">{client.email}</span>
                      </span>
                    </label>
                  )
                })}
              </div>

              {/* Message body */}
              <textarea
                value={broadcastBody}
                onChange={e => setBroadcastBody(e.target.value)}
                placeholder="Type a message to send to everyone selected…"
                rows={4}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm leading-5 focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
              />
            </div>

            {/* Footer */}
            <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-500">
                Sending to {broadcastSelected.size} client{broadcastSelected.size === 1 ? '' : 's'}
              </p>
              <button
                onClick={sendBroadcast}
                disabled={broadcastSending || broadcastSelected.size === 0 || !broadcastBody.trim()}
                className="min-h-[44px] px-4 rounded-lg bg-[#E8670A] text-white text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 transition-colors"
              >
                {broadcastSending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
