import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { API_URL } from '../config.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString()
}

const STAFF_THREAD_LABELS = {
  coach_thread:  'Coach Thread',
  admin_private: 'Admin Private',
  ai_admin:      'AI Admin',
}

// ── Staff Inbox component ─────────────────────────────────────────────────────
// Reused on the Coaching → Messaging tab AND the main Messages page for staff.

export default function StaffInbox({ getToken }) {
  const [inbox,       setInbox]       = useState([])
  const [loading,     setLoading]     = useState(true)
  const [selected,    setSelected]    = useState(null) // { clientId, clientName, threadType }
  const [messages,    setMessages]    = useState([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [body,        setBody]        = useState('')
  const [sending,     setSending]     = useState(false)
  const scrollRef    = useRef(null)
  const selectedRef  = useRef(null)
  const msgCountRef  = useRef(0)
  const fileInputRef  = useRef(null)
  const [imgPreview,  setImgPreview]  = useState(null)
  const [imgFile,     setImgFile]     = useState(null)
  const [uploading,   setUploading]   = useState(false)

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

  useEffect(() => { selectedRef.current = selected }, [selected])

  // ── Group inbox rows by client ────────────────────────────────────────────
  const groupedInbox = useMemo(() => {
    const map = new Map()
    for (const row of inbox) {
      const existing = map.get(row.client_id)
      if (!existing) {
        map.set(row.client_id, {
          client_id:         row.client_id,
          first_name:        row.first_name,
          totalUnread:       Number(row.unread) || 0,
          last_message_at:   row.last_message_at,
          last_message_body: row.last_message_body,
          last_sender_role:  row.last_sender_role,
          latestThreadType:  row.thread_type,
          threads:           [row],
        })
      } else {
        existing.threads.push(row)
        existing.totalUnread += Number(row.unread) || 0
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
      const res = await fetch(`${API_URL}/api/coach-admin/messaging/inbox`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const fresh = await res.json()
      setInbox(prev => {
        const sel = selectedRef.current
        if (!sel) return fresh
        return fresh.map(r =>
          r.client_id === sel.clientId && r.thread_type === sel.threadType
            ? { ...r, unread: 0 } : r,
        )
      })
    } catch {}
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
    const token = await getToken()
    const res = await fetch(
      `${API_URL}/api/coach-admin/clients/${sel.clientId}/messages?thread=${sel.threadType}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (res.ok) {
      const data = await res.json()
      setMessages(data)
      msgCountRef.current = data.length
      setInbox(prev => prev.map(r =>
        r.client_id === sel.clientId && r.thread_type === sel.threadType
          ? { ...r, unread: 0 } : r,
      ))
    }
    setLoadingMsgs(false)
  }, [getToken])

  useEffect(() => { loadConversation(selected) }, [selected, loadConversation])

  // Poll conversation every 20 s
  useEffect(() => {
    if (!selected) return
    const poll = async () => {
      try {
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/api/coach-admin/clients/${selected.clientId}/messages?thread=${selected.threadType}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (!res.ok) return
        const data = await res.json()
        if (data.length !== msgCountRef.current) {
          setMessages(data)
          msgCountRef.current = data.length
        }
      } catch {}
    }
    const id = setInterval(poll, 20_000)
    return () => clearInterval(id)
  }, [selected, getToken])

  useEffect(() => {
    if (messages.length > 0 && messages.length >= msgCountRef.current) {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  async function send() {
    if (!body.trim() && !imgFile) return
    if (sending || uploading) return
    setSending(true)
    try {
      let image_url = null
      if (imgFile) image_url = await uploadImage(imgFile)
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${selected.clientId}/messages`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message_body: body, thread_type: selected.threadType, image_url }),
      })
      if (res.ok) {
        const msg = await res.json()
        setMessages(m => [...m, msg])
        setBody(''); clearImage()
      }
    } catch { alert('Could not send message') }
    finally { setSending(false) }
  }

  if (loading) return <p className="text-sm text-gray-400 py-8 text-center">Loading inbox…</p>

  if (!loading && inbox.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
        <p className="text-3xl mb-3">💬</p>
        <p className="text-sm font-semibold text-gray-700 mb-1">Client inbox is ready</p>
        <p className="text-xs text-gray-500">New client conversations and replies will appear here automatically.</p>
      </div>
    )
  }

  const totalUnread = groupedInbox.reduce((sum, g) => sum + g.totalUnread, 0)

  return (
    <div className="flex flex-col lg:flex-row gap-4 min-h-[600px]">
      {/* Inbox list */}
      <div className="lg:w-72 shrink-0 space-y-1.5 overflow-y-auto">
        {totalUnread > 0 && (
          <p className="text-xs font-semibold text-[#E8670A] mb-2 px-1">
            {totalUnread} unread message{totalUnread !== 1 ? 's' : ''}
          </p>
        )}
        {groupedInbox.map(g => {
          const isSelected = selected?.clientId === g.client_id
          const hasUnread  = g.totalUnread > 0
          return (
            <button
              key={g.client_id}
              onClick={() => setSelected({ clientId: g.client_id, clientName: g.first_name, threadType: g.latestThreadType })}
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
                    {g.first_name ?? 'Client'}
                  </p>
                  <p className={`text-[10px] mt-0.5 ${isSelected ? 'text-white/70' : 'text-gray-400'}`}>
                    {g.last_message_at ? fmtTime(g.last_message_at) : ''}
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
                    {g.totalUnread}
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Conversation panel */}
      <div className="flex-1 flex flex-col bg-white border border-gray-200 rounded-xl overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
            Select a client to view messages
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <p className="text-sm font-semibold text-gray-900">{selected.clientName}</p>
              {selectedClientThreads.length > 1 && (
                <div className="flex gap-1 mt-2 flex-wrap">
                  {selectedClientThreads.map(t => {
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
              {loadingMsgs && <p className="text-center text-xs text-gray-400">Loading…</p>}
              {!loadingMsgs && messages.length === 0 && (
                <p className="text-center text-xs text-gray-400 py-8">No messages in this thread yet.</p>
              )}
              {messages.map(m => {
                const isStaff = m.sender_role === 'admin' || m.sender_role === 'coach'
                return (
                  <div key={m.id} className={`flex ${isStaff ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                      isStaff ? 'bg-[#E8670A] text-white' : 'bg-white border border-gray-200 text-gray-800'
                    }`}>
                      <p className="text-[10px] font-semibold opacity-70 mb-0.5">
                        {m.sender_name ?? m.sender_role} · {fmtTime(m.created_at)}
                      </p>
                      {m.message_body && <p className="text-sm whitespace-pre-wrap">{m.message_body}</p>}
                      {m.image_url && (
                        <img src={m.image_url} alt="attachment" className="max-w-[240px] rounded-lg mt-1 cursor-pointer" onClick={() => window.open(m.image_url, '_blank')} />
                      )}
                      {isStaff && m.read_at && (
                        <p className="text-[9px] opacity-60 text-right mt-0.5">
                          Read {new Date(m.read_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="border-t border-gray-100 p-3 space-y-2">
              {imgPreview && (
                <div className="relative inline-block">
                  <img src={imgPreview} alt="preview" className="max-h-28 rounded-lg border border-gray-200" />
                  <button onClick={clearImage} className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center leading-none font-bold">×</button>
                </div>
              )}
              <div className="flex gap-2">
                <input ref={fileInputRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" capture="environment" className="hidden" onChange={handleFileSelect} />
                <button onClick={() => fileInputRef.current?.click()} title="Attach image" className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors self-end">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                </button>
                <textarea
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  placeholder={`Message ${selected.clientName ?? 'client'}…`}
                  rows={2}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
                />
                <button
                  onClick={send}
                  disabled={sending || uploading || (!body.trim() && !imgFile)}
                  className="bg-[#E8670A] text-white px-5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 self-stretch min-w-[80px]"
                >
                  {uploading ? '⬆' : sending ? '…' : 'Send'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
