import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

function getThreadMeta(threadType, coachName) {
  if (threadType === 'ai_admin')      return { title: 'Coach Katie',              icon: '🤖', subtitle: 'You and Coach Katie' }
  if (threadType === 'admin_private') return { title: 'Jason Cook',               icon: '🔒', subtitle: 'Private message from Jason Cook' }
  if (threadType === 'coach_thread')  return { title: coachName || 'Your Coach',  icon: '💬', subtitle: `Messages with ${coachName || 'your coach'}` }
  return { title: threadType, icon: '💬', subtitle: '' }
}

function fmtTime(iso) {
  const d = new Date(iso)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  if (isToday) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString()
}

export default function Messages() {
  const { getToken } = useAuth()
  const [threads,   setThreads]   = useState([])
  const [coachName, setCoachName] = useState(null)
  const [active,    setActive]    = useState(null)  // thread_type string
  const [messages, setMessages] = useState([])
  const [body,    setBody]      = useState('')
  const [loading, setLoading]   = useState(true)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [sending, setSending]   = useState(false)
  const scrollRef = useRef(null)

  const loadThreads = useCallback(async () => {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/messages/threads`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      const data = await res.json()
      // Support both old array shape and new { threads, coachName } shape
      const list  = Array.isArray(data) ? data : (data.threads ?? [])
      const coach = Array.isArray(data) ? null : (data.coachName ?? null)
      setThreads(list)
      setCoachName(coach)
      // Auto-open the first thread on first load
      if (!active && list.length > 0) {
        setActive(list[0].thread_type)
      }
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

  // Auto-scroll to bottom whenever messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
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
      // Refresh thread list for last-message preview
      loadThreads()
    } else {
      const err = await res.json().catch(() => ({}))
      alert(err.error ?? 'Could not send message')
    }
  }

  const activeThread = threads.find(t => t.thread_type === active)
  const canReply = active && active !== 'admin_private'

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
        <div className="flex flex-col lg:flex-row gap-4">
          {/* Thread list */}
          <div className="lg:w-64 shrink-0 space-y-1.5">
            {threads.map(t => {
              const meta = getThreadMeta(t.thread_type, coachName)
              const isActive = active === t.thread_type
              return (
                <button
                  key={t.thread_type}
                  onClick={() => setActive(t.thread_type)}
                  className={`w-full text-left border rounded-xl px-3 py-3 transition-all ${
                    isActive
                      ? 'bg-[#E8670A] border-[#E8670A] text-white shadow-md'
                      : 'bg-white border-gray-200 hover:border-[#E8670A]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className={`text-sm font-semibold flex items-center gap-1.5 ${isActive ? 'text-white' : 'text-gray-900'}`}>
                        <span>{meta.icon}</span>{meta.title}
                      </p>
                      <p className={`text-[10px] mt-0.5 ${isActive ? 'text-white/80' : 'text-gray-400'}`}>
                        {meta.subtitle}
                      </p>
                      {t.last_message_body && (
                        <p className={`text-xs mt-1.5 truncate ${isActive ? 'text-white/80' : 'text-gray-500'}`}>
                          {t.last_message_body}
                        </p>
                      )}
                    </div>
                    {Number(t.unread) > 0 && !isActive && (
                      <span className="bg-[#E8670A] text-white text-[10px] font-bold rounded-full px-2 py-0.5 shrink-0">
                        {t.unread}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Message pane */}
          <div className="flex-1 flex flex-col bg-white border border-gray-200 rounded-xl overflow-hidden min-h-[500px]">
            {active && (
              <>
                <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
                  <p className="text-sm font-semibold text-gray-900">
                    {getThreadMeta(active, coachName).icon} {getThreadMeta(active, coachName).title}
                  </p>
                  {!canReply && (
                    <p className="text-[10px] text-amber-700 mt-0.5">
                      🔒 This is a one-way thread from Jason Cook. You cannot reply here.
                    </p>
                  )}
                </div>

                <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 bg-gray-50 space-y-3 max-h-[500px]">
                  {loadingMsgs && <p className="text-center text-xs text-gray-400">Loading…</p>}
                  {!loadingMsgs && messages.length === 0 && (
                    <p className="text-center text-xs text-gray-400 py-8">
                      No messages yet in this thread.
                    </p>
                  )}
                  {messages.map(m => {
                    const isMe = m.sender_role === 'client'
                    return (
                      <div key={m.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                          isMe
                            ? 'bg-[#E8670A] text-white'
                            : 'bg-white border border-gray-200 text-gray-800'
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

                {canReply && (
                  <div className="border-t border-gray-100 p-3 flex gap-2">
                    <textarea
                      value={body}
                      onChange={e => setBody(e.target.value)}
                      placeholder="Type a message…"
                      rows={2}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
                      }}
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
            )}
            {!active && (
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
