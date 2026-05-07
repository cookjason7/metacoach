import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { linkify } from '../utils/linkify'

function MessageBubble({ role, content }) {
  const isKatie = role === 'assistant'
  return (
    <div className={`flex ${isKatie ? 'justify-start' : 'justify-end'} mb-4`}>
      {isKatie && (
        <div className="w-8 h-8 rounded-full bg-[#fde8c8] flex items-center justify-center text-[#E8670A] font-bold text-xs mr-2 mt-1 shrink-0">
          K
        </div>
      )}
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
          isKatie
            ? 'bg-gray-100 text-gray-800 rounded-tl-sm'
            : 'bg-[#E8670A] text-white rounded-tr-sm'
        }`}
      >
        {content
          ? (isKatie ? linkify(content) : content)
          : <span className="inline-block animate-pulse text-gray-400 text-base tracking-widest">●●●</span>
        }
      </div>
    </div>
  )
}

export default function AICoach() {
  const { getToken } = useAuth()
  const [messages, setMessages]   = useState([])
  const [input, setInput]         = useState('')
  const [loading, setLoading]     = useState(true)
  const [streaming, setStreaming] = useState(false)
  const [error, setError]         = useState(null)
  const bottomRef = useRef(null)
  const inputRef  = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const streamResponse = useCallback(async (userMessage) => {
    setStreaming(true)
    setError(null)

    const bubbleId = Date.now()
    setMessages(prev => [...prev, { id: bubbleId, role: 'assistant', content: '' }])

    try {
      const token = await getToken()
      const res = await fetch('/api/coach/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(userMessage ? { message: userMessage } : {}),
      })

      if (!res.ok) throw new Error(`Server error ${res.status}`)

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') { setStreaming(false); return }
          try {
            const parsed = JSON.parse(raw)
            if (parsed.error) throw new Error(parsed.error)
            setMessages(prev =>
              prev.map(m => m.id === bubbleId ? { ...m, content: m.content + parsed.text } : m)
            )
          } catch {
            // skip malformed SSE chunk
          }
        }
      }
    } catch (err) {
      setError(err.message)
      setMessages(prev => prev.filter(m => m.id !== bubbleId))
    } finally {
      setStreaming(false)
      inputRef.current?.focus()
    }
  }, [getToken])

  useEffect(() => {
    async function init() {
      try {
        const token = await getToken()
        const res   = await fetch('/api/coach/history', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error('Failed to load history')
        const data = await res.json()

        if (data.length === 0) {
          setLoading(false)
          await streamResponse(null)
        } else {
          setMessages(data.map((m, i) => ({ id: i, role: m.role, content: m.message })))
          setLoading(false)
        }
      } catch (err) {
        setError(err.message)
        setLoading(false)
      }
    }
    init()
  }, [getToken, streamResponse])

  async function send() {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')
    setMessages(prev => [...prev, { id: Date.now(), role: 'user', content: text }])
    await streamResponse(text)
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 4rem)' }}>

      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-gray-100 shrink-0">
        <h1 className="text-xl font-bold text-gray-900">Coach Katie</h1>
        <p className="text-sm text-gray-500 mt-0.5">Chat with Katie, your personal coaching engine</p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <div className="flex justify-center items-center h-full">
            <span className="text-sm text-gray-400">Loading conversation…</span>
          </div>
        ) : (
          <>
            {messages.map(m => (
              <MessageBubble key={m.id} role={m.role} content={m.content} />
            ))}
            {error && (
              <p className="text-center text-xs text-red-500 mt-2 mb-1">{error}</p>
            )}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Input bar */}
      <div className="px-6 pb-6 pt-3 border-t border-gray-100 shrink-0">
        <div className="flex gap-3 items-end">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={streaming || loading}
            placeholder="Message Katie…"
            className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#E8670A] disabled:opacity-50 overflow-y-auto"
            style={{ minHeight: '42px', maxHeight: '120px' }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || streaming || loading}
            className="bg-[#E8670A] text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {streaming ? '…' : 'Send'}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-2">Enter to send · Shift+Enter for new line</p>
      </div>

    </div>
  )
}
