import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'
import { useVoiceRecorder } from '../hooks/useVoiceRecorder.js'

const NAVY  = '#1e2a3a'
const ORANGE = '#f97316'

function initials(first, last) {
  const a = (first || '').trim().charAt(0)
  const b = (last  || '').trim().charAt(0)
  return (a + b).toUpperCase() || '?'
}

function fullName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Staff member'
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const yest = new Date(now); yest.setDate(yest.getDate() - 1)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return time
  if (d.toDateString() === yest.toDateString()) return `Yesterday ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

function fmtShort(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const yest = new Date(now); yest.setDate(yest.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === yest.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function StaffChat() {
  const { getToken } = useAuth()
  const location = useLocation()

  const [meId,    setMeId]    = useState(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [myFirstName, setMyFirstName] = useState(null)

  const [channels, setChannels] = useState([])
  const [dms,      setDms]      = useState([])
  const [staffUsers, setStaffUsers] = useState([])
  const [search,   setSearch]   = useState('')

  const [activeType, setActiveType] = useState(null) // 'channel' | 'dm'
  const [activeId,   setActiveId]   = useState(null)
  const [activeMeta, setActiveMeta] = useState(null)  // { name, isPrivate } or staff user row

  const [messages,    setMessages]    = useState([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [showPinned,  setShowPinned]  = useState(false)

  const [composeText, setComposeText] = useState('')
  const [sending,     setSending]     = useState(false)
  const [uploading,   setUploading]   = useState(false)
  const [attachedFile, setAttachedFile] = useState(null)

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newChanName,     setNewChanName]     = useState('')
  const [newChanPrivate,  setNewChanPrivate]  = useState(false)
  const [newChanDesc,     setNewChanDesc]     = useState('')
  const [newChanMemberIds, setNewChanMemberIds] = useState(new Set())
  const [creatingChan,    setCreatingChan]    = useState(false)

  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [channelMembers,    setChannelMembers]    = useState([])
  const [loadingMembers,    setLoadingMembers]    = useState(false)
  const [addMemberIds,      setAddMemberIds]      = useState(new Set())
  const [memberSearch,      setMemberSearch]      = useState('')
  const [savingMembers,     setSavingMembers]     = useState(false)
  const [removingMemberId,  setRemovingMemberId]  = useState(null)
  const [deletingChannel,   setDeletingChannel]   = useState(false)

  const scrollRef    = useRef(null)
  const fileInputRef = useRef(null)
  const didDeepLink   = useRef(false)

  const { canRecord, recording, audioBlob, audioPreview, recordError, startRecording, stopRecording, clearAudio } = useVoiceRecorder()

  // ── Identity ────────────────────────────────────────────────────────────
  useEffect(() => {
    async function loadMe() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const data = await res.json()
          setMeId(data.id)
          setIsAdmin(data.role === 'admin' || data.role === 'account_owner')
          setMyFirstName(data.first_name ?? null)
        }
      } catch {}
    }
    loadMe()
  }, [getToken])

  // ── Load channel + DM lists ─────────────────────────────────────────────
  const loadChannels = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/staff-chat/channels`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setChannels(await res.json())
    } catch {}
  }, [getToken])

  const loadDms = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/staff-chat/dms`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setDms(await res.json())
    } catch {}
  }, [getToken])

  const loadStaffUsers = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/staff-chat/staff-users`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setStaffUsers(await res.json())
    } catch {}
  }, [getToken])

  useEffect(() => { loadChannels(); loadDms(); loadStaffUsers() }, [loadChannels, loadDms, loadStaffUsers])
  useEffect(() => {
    const id = setInterval(() => { loadChannels(); loadDms() }, 30_000)
    return () => clearInterval(id)
  }, [loadChannels, loadDms])

  // Deep link from a push notification tap: /staff-chat?channel=ID or ?dm=ID
  useEffect(() => {
    if (didDeepLink.current) return
    const params = new URLSearchParams(location.search)
    const channelId = params.get('channel')
    const dmId = params.get('dm')
    if (channelId) {
      didDeepLink.current = true
      setActiveType('channel'); setActiveId(Number(channelId))
      window.history.replaceState({}, '', '/staff-chat')
    } else if (dmId) {
      didDeepLink.current = true
      setActiveType('dm'); setActiveId(Number(dmId))
      window.history.replaceState({}, '', '/staff-chat')
    }
  }, [location])

  // Keep activeMeta in sync with fresh list data (name/unread may change)
  useEffect(() => {
    if (activeType === 'channel') {
      const c = channels.find(c => c.id === activeId)
      if (c) setActiveMeta(c)
    } else if (activeType === 'dm') {
      const u = dms.find(u => u.id === activeId)
      if (u) setActiveMeta(u)
    }
  }, [activeType, activeId, channels, dms])

  function messagesUrl() {
    return activeType === 'channel'
      ? `${API_URL}/api/staff-chat/channels/${activeId}/messages`
      : `${API_URL}/api/staff-chat/dms/${activeId}`
  }
  function readUrl() {
    return activeType === 'channel'
      ? `${API_URL}/api/staff-chat/channels/${activeId}/read`
      : `${API_URL}/api/staff-chat/dms/${activeId}/read`
  }
  function pinUrl(msgId) {
    return activeType === 'channel'
      ? `${API_URL}/api/staff-chat/channels/${activeId}/messages/${msgId}/pin`
      : `${API_URL}/api/staff-chat/dms/${activeId}/pin/${msgId}`
  }

  const loadMessages = useCallback(async () => {
    if (!activeType || !activeId) return
    setLoadingMsgs(true)
    try {
      const token = await getToken()
      const res = await fetch(`${messagesUrl()}?limit=50`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) {
        const data = await res.json()
        setMessages(data.messages ?? [])
      }
      // mark read, then refresh badge counts
      fetch(readUrl(), { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
        .then(() => { loadChannels(); loadDms() })
        .catch(() => {})
    } finally { setLoadingMsgs(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType, activeId, getToken])

  useEffect(() => { loadMessages() }, [loadMessages])

  // Poll active conversation every 10s, appending only new messages
  useEffect(() => {
    if (!activeType || !activeId) return
    const poll = async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${messagesUrl()}?limit=50`, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) return
        const data = await res.json()
        const fresh = data.messages ?? []
        setMessages(prev => {
          const ids = new Set(prev.map(m => m.id))
          const hasNew = fresh.some(m => !ids.has(m.id))
          if (!hasNew && fresh.length === prev.length) return prev
          const merged = [...prev, ...fresh.filter(m => !ids.has(m.id))]
          merged.sort((a, b) => a.id - b.id)
          return merged
        })
        fetch(readUrl(), { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
          .then(() => { loadChannels(); loadDms() })
          .catch(() => {})
      } catch {}
    }
    const id = setInterval(poll, 10_000)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType, activeId, getToken])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  // ── Send ────────────────────────────────────────────────────────────────
  async function uploadAudio(blob) {
    const token = await getToken()
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm'
    const fd = new FormData(); fd.append('audio', blob, `voice-message.${ext}`)
    const res = await fetch(`${API_URL}/api/staff-chat/upload-audio`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
    })
    if (!res.ok) throw new Error('Audio upload failed')
    return (await res.json()).url
  }

  async function uploadAttachment(file) {
    const token = await getToken()
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch(`${API_URL}/api/staff-chat/upload-attachment`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
    })
    if (!res.ok) throw new Error('File upload failed')
    return await res.json()
  }

  async function send() {
    if (!composeText.trim() && !audioBlob && !attachedFile) return
    if (sending || uploading) return
    setSending(true)
    try {
      let audio_url = null, attachment_url = null, attachment_name = null
      setUploading(true)
      if (audioBlob) audio_url = await uploadAudio(audioBlob)
      if (attachedFile) {
        const r = await uploadAttachment(attachedFile)
        attachment_url = r.url
        attachment_name = r.original_name
      }
      setUploading(false)
      const token = await getToken()
      const res = await fetch(messagesUrl(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_body: composeText, audio_url, attachment_url, attachment_name }),
      })
      if (res.ok) {
        const msg = await res.json()
        setMessages(m => [...m, msg])
        setComposeText(''); clearAudio(); setAttachedFile(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
        loadChannels(); loadDms()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error ?? 'Could not send message')
      }
    } catch { alert('Could not send message') }
    finally { setSending(false); setUploading(false) }
  }

  async function togglePin(msgId) {
    try {
      const token = await getToken()
      const res = await fetch(pinUrl(msgId), { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) {
        const updated = await res.json()
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, ...updated } : m))
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error ?? 'Could not update pin')
      }
    } catch { alert('Could not update pin') }
  }

  async function createChannel(e) {
    e.preventDefault()
    if (!newChanName.trim() || creatingChan) return
    setCreatingChan(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/staff-chat/channels`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newChanName.trim(),
          is_private: newChanPrivate,
          description: newChanDesc.trim() || null,
          member_ids: [...newChanMemberIds],
        }),
      })
      if (res.ok) {
        const channel = await res.json()
        await loadChannels()
        setActiveType('channel'); setActiveId(channel.id)
        setShowCreateModal(false)
        setNewChanName(''); setNewChanPrivate(false); setNewChanDesc(''); setNewChanMemberIds(new Set())
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error ?? 'Could not create channel')
      }
    } catch { alert('Could not create channel') }
    finally { setCreatingChan(false) }
  }

  function toggleNewChanMember(id) {
    setNewChanMemberIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  // ── Channel settings (admin) ───────────────────────────────────────────
  async function openChannelSettings() {
    setShowSettingsModal(true)
    setAddMemberIds(new Set())
    setMemberSearch('')
    setLoadingMembers(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/staff-chat/channels/${activeId}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setChannelMembers(await res.json())
    } finally { setLoadingMembers(false) }
  }

  function toggleAddMember(id) {
    setAddMemberIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function addSelectedMembers() {
    if (!addMemberIds.size || savingMembers) return
    setSavingMembers(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/staff-chat/channels/${activeId}/members`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: [...addMemberIds] }),
      })
      if (res.ok) {
        setAddMemberIds(new Set())
        await openChannelSettings()
        loadChannels()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error ?? 'Could not add members')
      }
    } catch { alert('Could not add members') }
    finally { setSavingMembers(false) }
  }

  async function removeMember(userId) {
    setRemovingMemberId(userId)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/staff-chat/channels/${activeId}/members/${userId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        setChannelMembers(prev => prev.filter(m => m.id !== userId))
        loadChannels()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error ?? 'Could not remove member')
      }
    } catch { alert('Could not remove member') }
    finally { setRemovingMemberId(null) }
  }

  async function deleteChannel() {
    if (!window.confirm('Are you sure? This will permanently delete all messages in this channel.')) return
    setDeletingChannel(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/staff-chat/channels/${activeId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        setShowSettingsModal(false)
        setActiveType(null); setActiveId(null)
        await loadChannels()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error ?? 'Could not delete channel')
      }
    } catch { alert('Could not delete channel') }
    finally { setDeletingChannel(false) }
  }

  function selectConversation(type, id) {
    setActiveType(type); setActiveId(id); setShowPinned(false)
  }

  function canPinMessage(m) {
    if (activeType === 'channel') return isAdmin
    return isAdmin || m.sender_id === meId
  }

  // ── Derived ─────────────────────────────────────────────────────────────
  const q = search.trim().toLowerCase()
  const filteredChannels = q ? channels.filter(c => c.name.toLowerCase().includes(q)) : channels
  const filteredDms = q ? dms.filter(u => fullName(u).toLowerCase().includes(q)) : dms
  const pinnedMessages = messages.filter(m => m.is_pinned)
  const headerTitle = activeType === 'channel'
    ? `# ${activeMeta?.name ?? ''}`
    : activeMeta ? fullName(activeMeta) : ''

  return (
    <div className="h-[calc(100vh-11rem)] lg:h-[calc(100vh-7rem)] rounded-xl overflow-hidden border border-gray-200 shadow-sm">
      <div className="flex h-full">

        {/* Left panel — conversation list */}
        <div
          className={`w-full lg:w-[280px] shrink-0 flex-col overflow-hidden ${activeType ? 'hidden lg:flex' : 'flex'}`}
          style={{ backgroundColor: NAVY }}
        >
          <div className="p-3 shrink-0">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Find a conversation..."
              className="w-full rounded-lg px-3 py-2.5 text-sm bg-white/10 text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#f97316] border border-white/10"
            />
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-4">
            {/* Channels */}
            <div>
              <div className="flex items-center justify-between px-2 mb-1">
                <p className="text-[11px] font-bold uppercase tracking-wider text-white/40">Channels</p>
                {isAdmin && (
                  <button
                    onClick={() => setShowCreateModal(true)}
                    aria-label="Create channel"
                    title="Create channel"
                    className="w-6 h-6 flex items-center justify-center rounded-md text-white/50 hover:bg-white/10 hover:text-white text-base leading-none"
                  >
                    +
                  </button>
                )}
              </div>
              <div className="space-y-0.5">
                {filteredChannels.map(c => {
                  const isActive = activeType === 'channel' && activeId === c.id
                  const hasUnread = Number(c.unread) > 0
                  return (
                    <button
                      key={c.id}
                      onClick={() => selectConversation('channel', c.id)}
                      className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left min-h-[44px] transition-colors"
                      style={isActive ? { backgroundColor: ORANGE, color: '#fff' } : undefined}
                    >
                      {!isActive && (
                        <span className="text-white/40 shrink-0">{c.is_private ? '🔒' : '#'}</span>
                      )}
                      {isActive && <span className="shrink-0">{c.is_private ? '🔒' : '#'}</span>}
                      <span className={`flex-1 min-w-0 truncate text-sm font-medium ${isActive ? 'text-white' : hasUnread ? 'text-white font-semibold' : 'text-white/70'}`}>
                        {c.name}
                      </span>
                      {hasUnread && !isActive && (
                        <span className="shrink-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold px-1" style={{ backgroundColor: ORANGE, color: '#fff' }}>
                          {c.unread}
                        </span>
                      )}
                    </button>
                  )
                })}
                {filteredChannels.length === 0 && (
                  <p className="text-xs text-white/30 px-2 py-2">No channels found.</p>
                )}
              </div>
            </div>

            {/* Direct Messages */}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-white/40 px-2 mb-1">Direct Messages</p>
              <div className="space-y-0.5">
                {filteredDms.map(u => {
                  const isActive = activeType === 'dm' && activeId === u.id
                  const hasUnread = Number(u.unread) > 0
                  return (
                    <button
                      key={u.id}
                      onClick={() => selectConversation('dm', u.id)}
                      className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left min-h-[44px] transition-colors"
                      style={isActive ? { backgroundColor: ORANGE, color: '#fff' } : undefined}
                    >
                      <span className="relative shrink-0">
                        <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold ${isActive ? 'bg-white/25 text-white' : 'bg-white/10 text-white/70'}`}>
                          {initials(u.first_name, u.last_name)}
                        </span>
                        <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2" style={{ '--tw-ring-color': NAVY }} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm font-medium ${isActive ? 'text-white' : hasUnread ? 'text-white font-semibold' : 'text-white/70'}`}>
                          {fullName(u)}
                        </span>
                      </span>
                      {hasUnread && !isActive && (
                        <span className="shrink-0 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold px-1" style={{ backgroundColor: ORANGE, color: '#fff' }}>
                          {u.unread}
                        </span>
                      )}
                    </button>
                  )
                })}
                {filteredDms.length === 0 && (
                  <p className="text-xs text-white/30 px-2 py-2">No staff found.</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right panel — conversation */}
        <div className={`flex-1 min-w-0 flex-col bg-white ${activeType ? 'flex' : 'hidden lg:flex'}`}>
          {!activeType && (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
              Select a channel or direct message
            </div>
          )}

          {activeType && (
            <>
              {/* Header */}
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-3 shrink-0">
                <button
                  onClick={() => { setActiveType(null); setActiveId(null) }}
                  className="lg:hidden -ml-1 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-200 transition-colors shrink-0"
                  aria-label="Back to conversations"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <p className="text-sm font-semibold text-gray-900 flex-1 min-w-0 truncate">{headerTitle}</p>
                {activeType === 'channel' && isAdmin && (
                  <button
                    onClick={openChannelSettings}
                    title="Channel settings"
                    aria-label="Channel settings"
                    className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-200 transition-colors shrink-0"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </button>
                )}
                {pinnedMessages.length > 0 && (
                  <button
                    onClick={() => setShowPinned(v => !v)}
                    className="min-h-[36px] px-2.5 rounded-lg text-xs font-semibold flex items-center gap-1 border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors shrink-0"
                    title="View pinned messages"
                  >
                    📌 {pinnedMessages.length}
                  </button>
                )}
              </div>

              {/* Pinned banner */}
              {showPinned && pinnedMessages.length > 0 && (
                <div className="border-b border-amber-100 bg-amber-50 max-h-40 overflow-y-auto shrink-0">
                  {pinnedMessages.map(m => (
                    <div key={`pinned-${m.id}`} className="px-4 py-2 border-b border-amber-100 last:border-0 flex items-start gap-2">
                      <span className="text-xs shrink-0 mt-0.5">📌</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold text-amber-800">
                          {m.sender_name ?? 'Staff'} · {fmtShort(m.created_at)}
                        </p>
                        <p className="text-xs text-amber-900 truncate">
                          {m.message_body || (m.audio_url ? 'Voice message' : m.attachment_name) || ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Messages */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 sm:p-4 bg-gray-50 space-y-3">
                {loadingMsgs && messages.length === 0 && (
                  <p className="text-center text-xs text-gray-400 py-8">Loading…</p>
                )}
                {!loadingMsgs && messages.length === 0 && (
                  <p className="text-center text-xs text-gray-400 py-8">No messages yet. Say hello!</p>
                )}
                {messages.map(m => {
                  const isMe = m.sender_id === meId
                  return (
                    <div key={m.id} className={`flex gap-2 ${isMe ? 'justify-end' : 'justify-start'}`}>
                      {!isMe && (
                        <span className="w-8 h-8 shrink-0 rounded-full bg-gray-200 text-gray-600 text-[11px] font-bold flex items-center justify-center mt-0.5">
                          {initials(m.sender_name, m.sender_last_name)}
                        </span>
                      )}
                      <div className="group relative max-w-[85%] sm:max-w-[70%]">
                        <div className={`rounded-2xl px-4 py-2 ${isMe ? 'bg-blue-500 text-white' : 'bg-white border border-gray-200 text-gray-900'}`}>
                          <p className={`text-[10px] font-semibold mb-0.5 flex items-center gap-1 ${isMe ? 'text-white/80' : 'text-gray-400'}`}>
                            {isMe ? 'You' : (m.sender_name ?? 'Staff')} · {fmtTime(m.created_at)}
                            {m.is_pinned && <span title="Pinned">📌</span>}
                          </p>
                          {m.message_body && <p className="text-sm whitespace-pre-wrap">{m.message_body}</p>}
                          {m.audio_url && (
                            <audio controls src={m.audio_url} className="mt-1 w-[min(240px,100%)]" style={{ height: 36 }} />
                          )}
                          {m.attachment_url && (
                            <a
                              href={m.attachment_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              download={m.attachment_name || true}
                              className={`mt-1.5 flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold min-h-[36px] ${
                                isMe ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                              }`}
                            >
                              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
                              </svg>
                              <span className="truncate">{m.attachment_name || 'Attachment'}</span>
                            </a>
                          )}
                        </div>
                        {canPinMessage(m) && (
                          <button
                            onClick={() => togglePin(m.id)}
                            title={m.is_pinned ? 'Unpin message' : 'Pin message'}
                            className={`absolute top-1 ${isMe ? '-left-8' : '-right-8'} w-7 h-7 flex items-center justify-center rounded-full text-gray-300 hover:text-amber-500 hover:bg-amber-50 opacity-0 group-hover:opacity-100 transition-opacity`}
                          >
                            📌
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Compose */}
              <div className="border-t border-gray-100 p-3 space-y-2 shrink-0 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                {attachedFile && (
                  <div className="flex items-center justify-between gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                    <span className="text-xs text-gray-600 truncate">{attachedFile.name}</span>
                    <button onClick={() => { setAttachedFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }} className="text-red-500 text-xs font-bold shrink-0">Remove</button>
                  </div>
                )}
                {audioPreview && (
                  <div className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                    <audio controls src={audioPreview} className="flex-1 min-w-0" style={{ height: 32 }} />
                    <button onClick={clearAudio} className="shrink-0 min-w-9 h-9 flex items-center justify-center rounded-lg bg-red-100 text-red-600 text-xs font-bold">×</button>
                  </div>
                )}
                {recording && (
                  <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-xs text-red-600 font-medium">Recording… tap ■ to stop and send</span>
                  </div>
                )}
                {recordError && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    {recordError === 'not_supported' ? 'Voice recording is not supported in this browser.'
                      : recordError === 'permission_denied' ? 'Microphone access was denied.'
                      : `Recording error: ${recordError}`}
                  </p>
                )}
                <input ref={fileInputRef} type="file" className="hidden" onChange={e => setAttachedFile(e.target.files?.[0] ?? null)} />
                <div className="flex items-end gap-2">
                  <textarea
                    value={composeText}
                    onChange={e => setComposeText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                    placeholder="Message the team…"
                    rows={2}
                    className="flex-1 min-w-0 min-h-[44px] max-h-32 border border-gray-300 rounded-lg px-3 py-2 text-sm leading-5 focus:outline-none focus:ring-2 resize-none overflow-y-auto"
                    style={{ '--tw-ring-color': ORANGE }}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={recording || !!audioBlob}
                    title="Attach a file"
                    className="shrink-0 min-w-[44px] h-[44px] flex items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:border-gray-400 disabled:opacity-30 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24L9.41 17.41a1 1 0 01-1.41-1.41l7.07-7.07" />
                    </svg>
                  </button>
                  <button
                    onClick={recording ? stopRecording : startRecording}
                    disabled={!!attachedFile}
                    title={!canRecord ? 'Voice recording not supported' : recording ? 'Stop and send' : 'Record voice message'}
                    className={`shrink-0 min-w-[44px] h-[44px] flex items-center justify-center rounded-lg border transition-colors disabled:opacity-30 ${
                      recording ? 'bg-red-500 border-red-500 text-white animate-pulse' : 'border-gray-300 text-gray-500 hover:border-gray-400'
                    }`}
                  >
                    {recording ? (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                    )}
                  </button>
                  <button
                    onClick={send}
                    disabled={sending || uploading || (!composeText.trim() && !audioBlob && !attachedFile)}
                    className="shrink-0 text-white px-4 rounded-lg text-sm font-semibold min-w-[76px] min-h-[44px] disabled:opacity-40 transition-colors"
                    style={{ backgroundColor: ORANGE }}
                  >
                    {uploading ? '⬆' : sending ? '…' : 'Send'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Create channel modal (admin only) */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-4 py-5">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-base font-bold text-gray-900">Create Channel</p>
              <button onClick={() => setShowCreateModal(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1">×</button>
            </div>
            <form onSubmit={createChannel} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Channel name</label>
                <input
                  type="text" value={newChanName} onChange={e => setNewChanName(e.target.value)}
                  placeholder="e.g. announcements" required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': ORANGE }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Description (optional)</label>
                <input
                  type="text" value={newChanDesc} onChange={e => setNewChanDesc(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': ORANGE }}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={newChanPrivate} onChange={e => setNewChanPrivate(e.target.checked)} className="w-4 h-4" />
                Private channel
              </label>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Members</label>
                <div className="border border-gray-200 rounded-lg max-h-40 overflow-y-auto divide-y divide-gray-100">
                  <label className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400 bg-gray-50">
                    <input type="checkbox" checked disabled className="w-4 h-4" />
                    {myFirstName ?? 'You'} (creator)
                  </label>
                  {staffUsers.map(u => (
                    <label key={u.id} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 min-h-[44px]">
                      <input
                        type="checkbox"
                        checked={newChanMemberIds.has(u.id)}
                        onChange={() => toggleNewChanMember(u.id)}
                        className="w-4 h-4"
                      />
                      {fullName(u)}
                    </label>
                  ))}
                  {staffUsers.length === 0 && (
                    <p className="text-xs text-gray-400 px-3 py-2">No other staff yet.</p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="submit" disabled={creatingChan || !newChanName.trim()}
                  className="flex-1 min-h-[44px] rounded-lg text-white text-sm font-semibold disabled:opacity-40"
                  style={{ backgroundColor: ORANGE }}
                >
                  {creatingChan ? 'Creating…' : 'Create'}
                </button>
                <button type="button" onClick={() => setShowCreateModal(false)} className="min-h-[44px] px-4 rounded-lg border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Channel settings modal (admin only) */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-4 py-5">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-gray-200 p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <p className="text-base font-bold text-gray-900">{activeMeta?.name ? `# ${activeMeta.name}` : 'Channel Settings'}</p>
              <button onClick={() => setShowSettingsModal(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1">×</button>
            </div>

            {/* Current members */}
            <div className="mb-4">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Members</p>
              {loadingMembers && <p className="text-xs text-gray-400 py-2">Loading…</p>}
              {!loadingMembers && (
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-40 overflow-y-auto">
                  {channelMembers.map(m => (
                    <div key={m.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="text-sm text-gray-700 truncate">{fullName(m)}</span>
                      <button
                        onClick={() => removeMember(m.id)}
                        disabled={removingMemberId === m.id}
                        title="Remove from channel"
                        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 font-bold text-sm"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {channelMembers.length === 0 && (
                    <p className="text-xs text-gray-400 px-3 py-2">No members yet.</p>
                  )}
                </div>
              )}
            </div>

            {/* Add members */}
            <div className="mb-5">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Add Members</p>
              <input
                type="text"
                value={memberSearch}
                onChange={e => setMemberSearch(e.target.value)}
                placeholder="Search staff…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2"
                style={{ '--tw-ring-color': ORANGE }}
              />
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-40 overflow-y-auto">
                {staffUsers
                  .filter(u => !channelMembers.some(m => m.id === u.id))
                  .filter(u => !memberSearch.trim() || fullName(u).toLowerCase().includes(memberSearch.trim().toLowerCase()))
                  .map(u => (
                    <label key={u.id} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 min-h-[44px]">
                      <input
                        type="checkbox"
                        checked={addMemberIds.has(u.id)}
                        onChange={() => toggleAddMember(u.id)}
                        className="w-4 h-4"
                      />
                      {fullName(u)}
                    </label>
                  ))}
                {staffUsers.filter(u => !channelMembers.some(m => m.id === u.id)).length === 0 && (
                  <p className="text-xs text-gray-400 px-3 py-2">Everyone is already a member.</p>
                )}
              </div>
              <button
                onClick={addSelectedMembers}
                disabled={!addMemberIds.size || savingMembers}
                className="mt-2 w-full min-h-[40px] rounded-lg text-white text-sm font-semibold disabled:opacity-40"
                style={{ backgroundColor: ORANGE }}
              >
                {savingMembers ? 'Adding…' : 'Add Selected'}
              </button>
            </div>

            <button
              onClick={deleteChannel}
              disabled={deletingChannel}
              className="w-full min-h-[44px] rounded-lg border border-red-200 bg-red-50 text-red-600 text-sm font-semibold hover:bg-red-100 disabled:opacity-40 transition-colors"
            >
              {deletingChannel ? 'Deleting…' : 'Delete Channel'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
