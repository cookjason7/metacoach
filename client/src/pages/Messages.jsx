import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'
import StaffInbox from '../components/StaffInbox.jsx'

// Only these three thread types are shown to clients.
// ai_coach, proactive_ai, and any other automated threads are intentionally excluded.
const HUMAN_THREAD_TYPES = ['admin_private', 'coach_thread', 'ai_admin']

function getThreadMeta(threadType, coachName) {
  if (threadType === 'admin_private') return { title: 'Jason Cook',              icon: '💬', subtitle: 'Messages with Jason Cook',                 canReply: true }
  if (threadType === 'coach_thread')  return { title: coachName || 'Your Coach', icon: '💬', subtitle: `Messages with ${coachName || 'your coach'}`, canReply: true }
  if (threadType === 'ai_admin')      return { title: 'Your Team',               icon: '💬', subtitle: 'Messages from your coaching team',         canReply: true }
  return { title: threadType, icon: '💬', subtitle: '', canReply: true }
}

function fmtTime(iso) {
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString()
}

export default function Messages() {
  const { getToken } = useAuth()
  const [isStaff,     setIsStaff]     = useState(null) // null = loading
  const [threads,     setThreads]     = useState([])
  const [coachName,   setCoachName]   = useState(null)
  const [active,      setActive]      = useState(null)  // thread_type string
  const [messages,    setMessages]    = useState([])
  const [body,        setBody]        = useState('')
  const [loading,     setLoading]     = useState(true)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [sending,     setSending]     = useState(false)
  const scrollRef = useRef(null)

  // Detect role once on mount
  useEffect(() => {
    async function checkRole() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const data = await res.json()
          setIsStaff(data.role === 'admin' || data.role === 'coach')
        } else {
          setIsStaff(false)
        }
      } catch { setIsStaff(false) }
    }
    checkRole()
  }, [getToken])

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
      // Auto-open first thread on first load only
      setActive(prev => (!prev && list.length > 0 ? list[0].thread_type : prev))
    }
    setLoading(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken])

  useEffect(() => { loadThreads() }, [loadThreads])

  const loadMessages = useCallback(async () => {
    if (!active) return
    setLoadingMsgs(true)
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/messages/thread/${active}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setMessages(await res.json())
    setLoadingMsgs(false)
  }, [active, getToken])

  useEffect(() => { loadMessages() }, [loadMessages])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  async function send() {
    if (!body.trim() || sending) return
    setSending(true)
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/messages/thread/${active}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_body: body }),
    })
    setSending(false)
    if (res.ok) {
      const msg = await res.json()
      setMessages(m => [...m, msg])
      setBody('')
      loadThreads()
    } else {
      const err = await res.json().catch(() => ({}))
      alert(err.error ?? 'Could not send message')
    }
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
        <StaffInbox getToken={getToken} />
      </div>
    )
  }

  // ── Client UI ─────────────────────────────────────────────────────────────
  const activeMeta = active ? getThreadMeta(active, coachName) : null

  return (
    <div className="max-w-5xl">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Messages</h1>
        <p className="text-sm text-gray-500">Chat with your coach and the team.</p>
      </div>

      {loading && <p className="text-center text-gray-400 py-12 text-sm">Loading messages…</p>}

      {!loading && threads.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-4xl mb-3">💬</p>
          <p className="text-sm text-gray-500">No messages yet. Your coach will reach out soon.</p>
        </div>
      )}

      {!loading && threads.length > 0 && (
        <div className="flex gap-4 min-h-[500px]">

          {/* Thread list — hidden on mobile when a conversation is open */}
          <div className={`lg:w-64 shrink-0 space-y-1.5 ${active ? 'hidden lg:block' : 'w-full lg:w-64'}`}>
            {threads.map(t => {
              const meta     = getThreadMeta(t.thread_type, coachName)
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
                      <p className={`text-sm font-semibold flex items-center gap-1.5 ${isActive ? 'text-white' : 'text-gray-900'}`}>
                        <span>{meta.icon}</span>{meta.title}
                      </p>
                      <p className={`text-[10px] mt-0.5 ${isActive ? 'text-white/80' : 'text-gray-400'}`}>
                        {meta.subtitle}
                      </p>
                      {t.last_message_body && (
                        <p className={`text-xs mt-1.5 truncate ${isActive ? 'text-white/80' : hasUnread ? 'text-gray-800 font-medium' : 'text-gray-500'}`}>
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
          <div className={`flex-1 flex flex-col bg-white border border-gray-200 rounded-xl overflow-hidden ${active ? 'flex' : 'hidden lg:flex'}`}>
            {active && activeMeta ? (
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
                      {activeMeta.icon} {activeMeta.title}
                    </p>
                    {!activeMeta.canReply && (
                      <p className="text-[10px] text-amber-700 mt-0.5">
                        🔒 One-way thread — you cannot reply here.
                      </p>
                    )}
                  </div>
                </div>

                {/* Messages */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 bg-gray-50 space-y-3 max-h-[500px]">
                  {loadingMsgs && <p className="text-center text-xs text-gray-400">Loading…</p>}
                  {!loadingMsgs && messages.length === 0 && (
                    <p className="text-center text-xs text-gray-400 py-8">No messages yet in this thread.</p>
                  )}
                  {messages.map(m => {
                    const isMe = m.sender_role === 'client'
                    return (
                      <div key={m.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                          isMe ? 'bg-[#E8670A] text-white' : 'bg-white border border-gray-200 text-gray-800'
                        }`}>
                          <p className={`text-[10px] font-semibold mb-0.5 ${isMe ? 'text-white/80' : 'text-gray-500'}`}>
                            {isMe ? 'You' : (m.sender_name ?? m.sender_role)} · {fmtTime(m.created_at)}
                          </p>
                          <p className="text-sm whitespace-pre-wrap">{m.message_body}</p>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Reply box */}
                {activeMeta.canReply && (
                  <div className="border-t border-gray-100 p-3 flex gap-2">
                    <textarea
                      value={body}
                      onChange={e => setBody(e.target.value)}
                      placeholder="Type a message…"
                      rows={2}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
                    />
                    <button
                      onClick={send}
                      disabled={sending || !body.trim()}
                      className="bg-[#E8670A] text-white px-5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 self-stretch min-w-[80px]"
                    >
                      {sending ? '…' : 'Send'}
                    </button>
                  </div>
                )}
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
