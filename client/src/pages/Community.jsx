import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { linkify } from '../utils/linkify'
import { API_URL } from '../config.js'
import { useOrgBranding } from '../context/OrgBrandingContext.jsx'
import { useViewMode } from '../context/ViewModeContext.jsx'

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString)) / 1000)
  if (seconds < 60)  return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)  return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)    return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7)      return `${days}d ago`
  return new Date(isoString).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const AVATAR_COLORS = [
  'bg-[#fde8c8]',
  'bg-purple-100 text-purple-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
]
function avatarColor(name) {
  return AVATAR_COLORS[(name?.charCodeAt(0) ?? 0) % AVATAR_COLORS.length]
}
// AVATAR_COLORS[0] has no text-color utility (it used the brand accent, which
// can't be a purged Tailwind arbitrary var() class) — style it inline instead.
function avatarStyle(name) {
  return (name?.charCodeAt(0) ?? 0) % AVATAR_COLORS.length === 0 ? { color: 'var(--color-accent-hover)' } : undefined
}
function Avatar({ name, size = 'md' }) {
  const cls = size === 'sm' ? 'w-7 h-7 text-xs' : 'w-9 h-9 text-sm'
  return (
    <div className={`${cls} ${avatarColor(name)} rounded-full flex items-center justify-center font-bold shrink-0`} style={avatarStyle(name)}>
      {name?.[0]?.toUpperCase() ?? '?'}
    </div>
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────

const REACTIONS = [
  { type: 'like',  emoji: '👍', countKey: 'like_count',  myKey: 'my_like'  },
  { type: 'love',  emoji: '❤️', countKey: 'love_count',  myKey: 'my_love'  },
  { type: 'laugh', emoji: '😂', countKey: 'laugh_count', myKey: 'my_laugh' },
  { type: 'care',  emoji: '🤗', countKey: 'care_count',  myKey: 'my_care'  },
]

const CATEGORIES = ['General Discussion', 'Non-Scale Victories']

function normalizeChannel(_ct) {
  return 'vip'  // one shared community for all coaching types
}

const CATEGORY_STYLES = {
  'General Discussion':  'bg-gray-100 text-gray-600 border-gray-200',
  'Announcements':       'bg-amber-50 text-amber-700 border-amber-200',
  'Non-Scale Victories': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Hurdles':             'bg-rose-50 text-rose-700 border-rose-200',
}

// ── MentionInput ──────────────────────────────────────────────────────────────

function MentionInput({ value, onChange, groupId, placeholder, rows = 3, inputClassName, textareaClassName }) {
  const { getToken } = useAuth()
  const ref   = useRef(null)
  const [query,  setQuery]  = useState(null)
  const [atPos,  setAtPos]  = useState(0)
  const [suggestions, setSuggestions] = useState([])

  // Debounced query against the server so results stay scoped to who the
  // asker can actually see (group roster, not the whole org) — see
  // GET /community/mention-search.
  useEffect(() => {
    if (query === null) { setSuggestions([]); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const token  = await getToken()
        const params = new URLSearchParams({ q: query })
        if (groupId) params.set('groupId', String(groupId))
        const res = await fetch(`${API_URL}/api/community/mention-search?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!cancelled) setSuggestions(res.ok ? await res.json() : [])
      } catch { if (!cancelled) setSuggestions([]) }
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, groupId, getToken])

  function handleChange(e) {
    onChange(e.target.value)
    const el     = e.target
    const cursor = el.selectionStart
    const before = el.value.slice(0, cursor)
    const match  = before.match(/(?<!\w)@([A-Za-z]\w*)$/)
    if (match) { setQuery(match[1]); setAtPos(cursor - match[0].length) }
    else setQuery(null)
  }

  function close() {
    setQuery(null)
    setSuggestions([])
  }

  function pick(name) {
    const el     = ref.current
    const cursor = el.selectionStart
    const before = value.slice(0, atPos)
    const after  = value.slice(cursor)
    onChange(`${before}@${name} ${after}`)
    close()
    setTimeout(() => {
      el.focus()
      const pos = atPos + name.length + 2
      el.setSelectionRange(pos, pos)
    }, 0)
  }

  // Suggestion buttons preventDefault on mousedown, which keeps focus on the
  // input so this blur only fires for a genuine click-away — safe to close
  // unconditionally without racing the pick() above.
  function handleBlur(e) {
    e.currentTarget.style.boxShadow = 'none'
    close()
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape' && query !== null) {
      e.stopPropagation()
      close()
    }
  }

  const isTextarea = rows > 1
  const showDropdown = query !== null && suggestions.length > 0

  return (
    <div className="relative w-full">
      {isTextarea ? (
        <textarea
          ref={ref}
          rows={rows}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={textareaClassName}
          onFocus={e => { e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent)' }}
          onBlur={handleBlur}
        />
      ) : (
        <input
          ref={ref}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={inputClassName}
          onFocus={e => { e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent)' }}
          onBlur={handleBlur}
        />
      )}
      {showDropdown && (
        <div className="absolute bottom-full left-0 mb-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-20">
          {suggestions.map(m => (
            <button
              key={m.id}
              type="button"
              onMouseDown={e => { e.preventDefault(); pick(m.first_name) }}
              className="flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-gray-50 text-left"
            >
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${avatarColor(m.first_name)}`} style={avatarStyle(m.first_name)}>
                {m.first_name?.[0]?.toUpperCase()}
              </div>
              {m.first_name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── PollCreator ───────────────────────────────────────────────────────────────

function PollCreator({ poll, onChange }) {
  function setQ(q)    { onChange({ ...poll, question: q }) }
  function setOpt(i, v) {
    const opts = [...poll.options]; opts[i] = v; onChange({ ...poll, options: opts })
  }
  function addOpt()    { if (poll.options.length < 4) onChange({ ...poll, options: [...poll.options, ''] }) }
  function removeOpt(i) {
    if (poll.options.length <= 2) return
    onChange({ ...poll, options: poll.options.filter((_, j) => j !== i) })
  }

  return (
    <div className="mt-3 p-4 bg-blue-50 rounded-xl border border-blue-200">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-blue-800">📊 Poll</span>
        <button type="button" onClick={() => onChange(null)} className="text-xs text-gray-400 hover:text-gray-600">Remove</button>
      </div>
      <input
        type="text"
        value={poll.question}
        onChange={e => setQ(e.target.value)}
        placeholder="Ask a question…"
        className="w-full border border-blue-200 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-blue-300"
      />
      {poll.options.map((opt, i) => (
        <div key={i} className="flex gap-2 mb-1.5">
          <input
            type="text"
            value={opt}
            onChange={e => setOpt(i, e.target.value)}
            placeholder={`Option ${i + 1}`}
            className="flex-1 border border-blue-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          {poll.options.length > 2 && (
            <button type="button" onClick={() => removeOpt(i)} className="text-gray-400 hover:text-red-500 text-sm px-1">✕</button>
          )}
        </div>
      ))}
      {poll.options.length < 4 && (
        <button type="button" onClick={addOpt} className="text-xs text-blue-600 hover:text-blue-800 mt-1">
          + Add option
        </button>
      )}
    </div>
  )
}

// ── PollDisplay ───────────────────────────────────────────────────────────────

function PollDisplay({ postId, getToken }) {
  const [poll,    setPoll]    = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/community/posts/${postId}/poll`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setPoll(await res.json())
      } catch {}
      setLoading(false)
    }
    load()
  }, [postId, getToken])

  async function vote(optionId) {
    if (!poll || poll.myVote !== null) return
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/polls/${poll.id}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ option_id: optionId }),
      })
      if (res.ok) {
        const data = await res.json()
        setPoll(p => ({ ...p, ...data }))
      }
    } catch {}
  }

  if (loading || !poll) return null

  const voted = poll.myVote !== null

  return (
    <div className="mt-3 p-4 bg-gray-50 rounded-xl border border-gray-200">
      <p className="text-sm font-semibold text-gray-900 mb-3">📊 {poll.question}</p>
      <div className="space-y-2">
        {poll.options.map(opt => {
          const pct      = poll.totalVotes > 0 ? Math.round((opt.vote_count / poll.totalVotes) * 100) : 0
          const isMyVote = opt.id === poll.myVote
          return (
            <button
              key={opt.id}
              onClick={() => vote(opt.id)}
              disabled={voted}
              className={`w-full text-left rounded-lg border px-3 py-2 text-sm transition-colors ${
                isMyVote ? 'bg-orange-50' : 'border-gray-200'
              } ${!voted ? 'hover:border-gray-300 cursor-pointer' : 'cursor-default'}`}
              style={isMyVote ? { borderColor: 'var(--color-accent)' } : undefined}
            >
              <div className="flex justify-between mb-1">
                <span className={isMyVote ? 'font-medium' : 'text-gray-800'} style={isMyVote ? { color: 'var(--color-accent)' } : undefined}>
                  {opt.option_text}{isMyVote ? ' ✓' : ''}
                </span>
                {voted && <span className="text-xs text-gray-500">{pct}%</span>}
              </div>
              {voted && (
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${isMyVote ? '' : 'bg-gray-400'}`}
                    style={{ width: `${pct}%`, background: isMyVote ? 'var(--color-accent)' : undefined }}
                  />
                </div>
              )}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-gray-400 mt-2">{poll.totalVotes} vote{poll.totalVotes !== 1 ? 's' : ''}</p>
    </div>
  )
}

// ── CommentItem ───────────────────────────────────────────────────────────────

// `isReply` renders the nested variant and suppresses the Reply affordance —
// threading is capped at one level, so a reply is never itself replyable.
// Reactions are keyed off comment.id either way, so a reply reacts as its own
// comment (comment_reactions.comment_id) with no special-casing.
function CommentItem({ comment, getToken, isAdmin, onDelete, isReply = false, onReplyClick }) {
  const [reactions, setReactions] = useState({
    like_count:  comment.like_count  ?? 0,
    love_count:  comment.love_count  ?? 0,
    laugh_count: comment.laugh_count ?? 0,
    care_count:  comment.care_count  ?? 0,
    my_like:     comment.my_like     ?? false,
    my_love:     comment.my_love     ?? false,
    my_laugh:    comment.my_laugh    ?? false,
    my_care:     comment.my_care     ?? false,
  })

  useEffect(() => {
    async function fetchReactions() {
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/community/comments/${comment.id}/reactions`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const data = await res.json()
        setReactions(r => ({
          ...r,
          like_count:  data.like  ?? r.like_count,
          love_count:  data.love  ?? r.love_count,
          laugh_count: data.laugh ?? r.laugh_count,
          care_count:  data.care  ?? r.care_count,
          my_like:     data.userReactions?.includes('like')  ?? r.my_like,
          my_love:     data.userReactions?.includes('love')  ?? r.my_love,
          my_laugh:    data.userReactions?.includes('laugh') ?? r.my_laugh,
          my_care:     data.userReactions?.includes('care')  ?? r.my_care,
        }))
      } catch {}
    }
    fetchReactions()
  }, [comment.id, getToken])

  async function toggleReaction(type) {
    const myKey    = `my_${type}`
    const countKey = `${type}_count`
    const was      = reactions[myKey]
    setReactions(r => ({ ...r, [myKey]: !was, [countKey]: r[countKey] + (was ? -1 : 1) }))
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/community/comments/${comment.id}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reaction_type: type }),
      })
      if (res.ok) {
        const data = await res.json()
        setReactions(r => ({
          ...r,
          like_count:  data.like_count,
          love_count:  data.love_count,
          laugh_count: data.laugh_count,
          care_count:  data.care_count,
          [myKey]: data.active,
        }))
      }
    } catch {
      setReactions(r => ({ ...r, [myKey]: was, [countKey]: r[countKey] + (was ? 1 : -1) }))
    }
  }

  return (
    <div className={`flex gap-2.5 ${isReply ? 'py-1.5' : 'py-2'}`}>
      <Avatar name={comment.first_name} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-semibold text-gray-800">{comment.first_name ?? 'Member'}</span>
          {isAdmin && (
            <button onClick={() => onDelete(comment.id)} className="text-xs text-red-400 hover:text-red-600 transition-colors">
              Delete
            </button>
          )}
        </div>
        <span className="text-xs text-gray-600 leading-relaxed">{linkify(comment.content)}</span>
        <div className="flex gap-2 mt-1.5">
          {REACTIONS.map(({ type, emoji, countKey, myKey }) => (
            <button
              key={type}
              onClick={() => toggleReaction(type)}
              className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors ${
                reactions[myKey] ? 'font-semibold' : 'text-gray-500 hover:text-gray-700'
              }`}
              style={reactions[myKey] ? { color: 'var(--color-accent)' } : undefined}
            >
              <span>{emoji}</span>
              <span>{reactions[countKey]}</span>
            </button>
          ))}
          {!isReply && onReplyClick && (
            <button
              onClick={() => onReplyClick(comment.id)}
              className="text-xs px-1.5 py-0.5 rounded text-gray-500 hover:text-gray-700 font-semibold transition-colors"
            >
              Reply
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── PostCard ──────────────────────────────────────────────────────────────────

function PostCard({ post, onLike, onToggleSave, onCommentSubmit, onDeletePost, onPin, onUpdate, getToken, isAdmin, isStaff, currentUserId, categories = CATEGORIES, highlighted = false }) {
  const [expanded,       setExpanded]       = useState(false)
  const [comments,       setComments]       = useState(null)
  const [loadingComments,setLoadingComments]= useState(false)
  const [commentText,    setCommentText]    = useState('')
  const [submitting,     setSubmitting]     = useState(false)
  const [replyingTo,     setReplyingTo]     = useState(null)  // top-level comment id, or null
  const [replyText,      setReplyText]      = useState('')
  const [replySubmitting,setReplySubmitting]= useState(false)
  const [localCount,     setLocalCount]     = useState(post.comment_count)
  const [postReactions,  setPostReactions]  = useState({
    like_count: 0, love_count: 0, laugh_count: 0, care_count: 0,
    my_like: false, my_love: false, my_laugh: false, my_care: false,
  })
  const [isEditing,      setIsEditing]      = useState(false)
  const [editContent,    setEditContent]    = useState(post.content)
  const [editCategory,   setEditCategory]   = useState(post.category ?? categories[0])
  const [saving,         setSaving]         = useState(false)
  const [showLikers,     setShowLikers]     = useState(false)
  const [showReactors,   setShowReactors]   = useState(false)

  const canEdit = isAdmin || post.user_id === currentUserId

  useEffect(() => {
    async function fetchPostReactions() {
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/community/posts/${post.id}/reactions`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const data = await res.json()
        setPostReactions({
          like_count:  data.like  ?? 0,
          love_count:  data.love  ?? 0,
          laugh_count: data.laugh ?? 0,
          care_count:  data.care  ?? 0,
          my_like:     data.userReactions?.includes('like')  ?? false,
          my_love:     data.userReactions?.includes('love')  ?? false,
          my_laugh:    data.userReactions?.includes('laugh') ?? false,
          my_care:     data.userReactions?.includes('care')  ?? false,
        })
      } catch {}
    }
    fetchPostReactions()
  }, [post.id, getToken])

  async function togglePostReaction(type) {
    const myKey    = `my_${type}`
    const countKey = `${type}_count`
    const was      = postReactions[myKey]
    setPostReactions(r => ({ ...r, [myKey]: !was, [countKey]: r[countKey] + (was ? -1 : 1) }))
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/community/posts/${post.id}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reaction_type: type }),
      })
      if (res.ok) {
        const data = await res.json()
        setPostReactions(r => ({
          ...r,
          like_count:  data.like_count,
          love_count:  data.love_count,
          laugh_count: data.laugh_count,
          care_count:  data.care_count,
          [myKey]: data.active,
        }))
      }
    } catch {
      setPostReactions(r => ({ ...r, [myKey]: was, [countKey]: r[countKey] + (was ? 1 : -1) }))
    }
  }

  // Server returns a flat list carrying parent_comment_id (see GET
  // /posts/:id/comments). Group it into one level of nesting here. A reply whose
  // parent isn't in the list (possible only at the server's LIMIT boundary) is
  // promoted to top level rather than dropped.
  const threadedComments = useMemo(() => {
    const list = comments ?? []
    const topLevel = list.filter(c => !c.parent_comment_id)
    const byId = new Set(topLevel.map(c => c.id))
    const orphans = list.filter(c => c.parent_comment_id && !byId.has(c.parent_comment_id))
    return [...topLevel, ...orphans]
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id)
      .map(c => ({
        comment: c,
        replies: list
          .filter(r => r.parent_comment_id === c.id)
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id),
      }))
  }, [comments])

  async function toggleComments() {
    const next = !expanded
    setExpanded(next)
    if (next && comments === null) {
      setLoadingComments(true)
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/community/posts/${post.id}/comments`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setComments(await res.json())
      } finally { setLoadingComments(false) }
    }
  }

  async function submitComment(e) {
    e.preventDefault()
    if (!commentText.trim() || submitting) return
    setSubmitting(true)
    try {
      const comment = await onCommentSubmit(post.id, commentText.trim())
      if (comment) {
        setComments(prev => [...(prev ?? []), comment])
        setLocalCount(c => c + 1)
        setCommentText('')
      }
    } finally { setSubmitting(false) }
  }

  function openReply(commentId) {
    setReplyingTo(prev => (prev === commentId ? null : commentId))
    setReplyText('')
  }

  async function submitReply(e) {
    e.preventDefault()
    if (!replyText.trim() || replySubmitting || !replyingTo) return
    setReplySubmitting(true)
    try {
      const reply = await onCommentSubmit(post.id, replyText.trim(), replyingTo)
      if (reply) {
        setComments(prev => [...(prev ?? []), reply])
        setLocalCount(c => c + 1)
        setReplyText('')
        setReplyingTo(null)
      }
    } finally { setReplySubmitting(false) }
  }

  async function deleteComment(commentId) {
    if (!window.confirm('Delete this comment?')) return
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/comments/${commentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        // Deleting a top-level comment cascades to its replies server-side
        // (post_comments.parent_comment_id ON DELETE CASCADE) — mirror that here
        // so the count and list stay in sync without a refetch.
        const isGone = c => c.id === commentId || c.parent_comment_id === commentId
        const removedCount = (comments ?? []).filter(isGone).length
        setComments(prev => (prev ?? []).filter(c => !isGone(c)))
        setLocalCount(n => n - (removedCount || 1))
        if (replyingTo === commentId) setReplyingTo(null)
      }
    } catch {}
  }

  async function saveEdit() {
    if (!editContent.trim()) return
    setSaving(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/posts/${post.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: editContent.trim(), category: editCategory }),
      })
      if (res.ok) {
        const data = await res.json()
        onUpdate(data)
        setIsEditing(false)
      }
    } finally { setSaving(false) }
  }

  const catStyle = post.category
    ? CATEGORY_STYLES[post.category] ?? 'bg-gray-100 text-gray-600 border-gray-200'
    : null

  return (
    <div
      id={`post-${post.id}`}
      className={`bg-white rounded-xl border overflow-hidden transition-shadow duration-500 ${
        highlighted ? '' : post.pinned ? 'border-amber-300' : 'border-gray-200'
      }`}
      style={highlighted ? { boxShadow: '0 0 0 2px var(--color-accent), 0 0 0 4px white' } : undefined}
    >
      {post.pinned && (
        <div className="flex items-center gap-1.5 px-5 py-2 bg-amber-50 border-b border-amber-200">
          <span className="text-xs">📌</span>
          <span className="text-xs font-medium text-amber-700">Pinned post</span>
        </div>
      )}

      <div className="p-4">
        {/* Header */}
        <div className="mb-3">
          {/* Row 1: avatar, name, actions */}
          <div className="flex items-center gap-3">
            <Avatar name={post.first_name} />
            <div className="flex-1 min-w-0 flex items-center gap-2">
              <p className="text-sm font-semibold text-gray-900 truncate">{post.first_name ?? 'Member'}</p>
              {post.hot && <span title="Trending" className="text-sm leading-none shrink-0">🔥</span>}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {canEdit && (
                <button
                  onClick={() => { setIsEditing(e => !e); setEditContent(post.content); setEditCategory(post.category ?? categories[0]) }}
                  className="text-sm text-gray-400 hover:text-gray-700 transition-colors"
                >
                  {isEditing ? 'Cancel' : 'Edit'}
                </button>
              )}
              {isAdmin && (
                <>
                  <button onClick={() => onPin(post.id)} className="text-sm text-amber-500 hover:text-amber-700 transition-colors">
                    {post.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button onClick={() => onDeletePost(post.id)} className="text-sm text-red-400 hover:text-red-600 transition-colors">
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
          {/* Row 2: category badge + timestamp, indented under avatar */}
          <div className="flex items-center gap-2 mt-1 pl-12">
            {catStyle && !isEditing && (
              <span className={`text-xs px-2 py-0.5 rounded-full border font-medium shrink-0 max-w-[9rem] truncate ${catStyle}`}>
                {post.category}
              </span>
            )}
            <p className="text-xs text-gray-400 shrink-0">{timeAgo(post.created_at)}</p>
          </div>
        </div>

        {/* Content or edit form */}
        {isEditing ? (
          <div className="mb-3">
            <textarea
              rows={3}
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none resize-none mb-2"
              onFocus={e => { e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent)' }}
              onBlur={e => { e.currentTarget.style.boxShadow = 'none' }}
            />
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <select
                value={editCategory}
                onChange={e => setEditCategory(e.target.value)}
                className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none bg-white"
                onFocus={e => { e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent)' }}
                onBlur={e => { e.currentTarget.style.boxShadow = 'none' }}
              >
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={saveEdit}
                disabled={saving || !editContent.trim()}
                className="text-white px-4 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors"
                style={{ background: 'var(--color-accent)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setIsEditing(false)} className="text-xs text-gray-500 hover:text-gray-700">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap mb-3">
            {linkify(post.content)}
          </p>
        )}

        {post.photo_url && (
          <div className="rounded-xl overflow-hidden mb-4 max-h-80">
            <img src={post.photo_url} alt="Post" className="w-full object-cover" />
          </div>
        )}

        {post.has_poll && <PollDisplay postId={post.id} getToken={getToken} />}

        {/* Reactions */}
        <div className="flex gap-2 mb-3">
          {REACTIONS.map(({ type, emoji, countKey, myKey }) => (
            <div
              key={type}
              className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors ${
                postReactions[myKey] ? 'font-semibold' : 'text-gray-500'
              }`}
              style={postReactions[myKey] ? { color: 'var(--color-accent)' } : undefined}
            >
              <button
                onClick={() => togglePostReaction(type)}
                aria-label={`${postReactions[myKey] ? 'Remove' : 'Add'} ${type} reaction`}
                className="hover:text-gray-700"
              >
                {emoji}
              </button>
              <button
                onClick={() => setShowReactors(true)}
                disabled={!postReactions[countKey]}
                className={postReactions[countKey] ? 'hover:text-gray-700 hover:underline cursor-pointer' : 'cursor-default'}
              >
                {postReactions[countKey]}
              </button>
            </div>
          ))}
        </div>

        {/* Like + comment bar */}
        <div className="flex items-center gap-5 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-1.5 text-sm">
            <button
              onClick={() => onLike(post.id)}
              aria-label={post.liked_by_me ? 'Unlike post' : 'Like post'}
              className={`transition-colors ${
                post.liked_by_me ? 'text-rose-500' : 'text-gray-400 hover:text-rose-400'
              }`}
            >
              <span>{post.liked_by_me ? '♥' : '♡'}</span>
            </button>
            <button
              onClick={() => setShowLikers(true)}
              disabled={!post.like_count}
              className={`min-w-[1.5rem] text-left ${
                post.like_count
                  ? 'text-gray-500 hover:text-gray-700 hover:underline cursor-pointer'
                  : 'text-gray-400 cursor-default'
              }`}
            >
              {post.like_count}
            </button>
          </div>
          <button
            onClick={toggleComments}
            className="flex items-center gap-1.5 text-sm text-gray-400 transition-colors"
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.color = '' }}
          >
            <span>💬</span>
            <span>{localCount}</span>
          </button>
          <button
            onClick={() => onToggleSave(post.id, !post.saved_by_me)}
            aria-label={post.saved_by_me ? 'Remove bookmark' : 'Save post'}
            aria-pressed={post.saved_by_me}
            title={post.saved_by_me ? 'Saved' : 'Save for later'}
            className="ml-auto min-w-[44px] min-h-[44px] flex items-center justify-center shrink-0 transition-colors text-gray-400 hover:text-gray-600"
            style={post.saved_by_me ? { color: 'var(--color-accent)' } : undefined}
          >
            {post.saved_by_me ? (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 3a1 1 0 0 0-1 1v17l7-4.5 7 4.5V4a1 1 0 0 0-1-1H6z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 3a1 1 0 0 0-1 1v17l7-4.5 7 4.5V4a1 1 0 0 0-1-1H6z" />
              </svg>
            )}
          </button>
        </div>

        {/* Comments */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            {loadingComments && <p className="text-xs text-gray-400 py-2">Loading…</p>}
            {comments?.length === 0 && !loadingComments && (
              <p className="text-xs text-gray-400 py-1">No comments yet. Be the first.</p>
            )}
            {threadedComments.map(({ comment: c, replies }) => (
              <div key={c.id}>
                <CommentItem
                  comment={c} getToken={getToken} isAdmin={isAdmin}
                  onDelete={deleteComment} onReplyClick={openReply}
                />
                {(replies.length > 0 || replyingTo === c.id) && (
                  <div className="ml-9 pl-3 border-l border-gray-100">
                    {replies.map(r => (
                      <CommentItem
                        key={r.id} comment={r} getToken={getToken} isAdmin={isAdmin}
                        onDelete={deleteComment} isReply
                      />
                    ))}
                    {replyingTo === c.id && (
                      <form onSubmit={submitReply} className="flex gap-2 mt-1.5 mb-1 items-end">
                        {/* min-w-0 lets the input shrink inside the indented row
                            instead of forcing horizontal scroll at 375px */}
                        <div className="flex-1 min-w-0">
                          <MentionInput
                            value={replyText}
                            onChange={setReplyText}
                            groupId={post.group_id}
                            placeholder={`Reply to ${c.first_name ?? 'Member'}…`}
                            rows={1}
                            inputClassName="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none"
                          />
                        </div>
                        <button
                          type="submit"
                          disabled={!replyText.trim() || replySubmitting}
                          className="text-white px-2.5 py-2 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors shrink-0"
                          style={{ background: 'var(--color-accent)' }}
                        >
                          Reply
                        </button>
                        <button
                          type="button"
                          onClick={() => setReplyingTo(null)}
                          className="text-xs text-gray-400 hover:text-gray-600 px-1.5 py-2 shrink-0"
                        >
                          Cancel
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            ))}
            <form onSubmit={submitComment} className="flex gap-2 mt-3 items-end">
              <MentionInput
                value={commentText}
                onChange={setCommentText}
                groupId={post.group_id}
                placeholder="Add a comment…"
                rows={1}
                inputClassName="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none"
              />
              <button
                type="submit"
                disabled={!commentText.trim() || submitting}
                className="text-white px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors shrink-0"
                style={{ background: 'var(--color-accent)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
              >
                Post
              </button>
            </form>
          </div>
        )}
      </div>

      {showLikers && (
        <LikedByModal postId={post.id} getToken={getToken} onClose={() => setShowLikers(false)} />
      )}

      {showReactors && (
        <ReactedByModal postId={post.id} getToken={getToken} onClose={() => setShowReactors(false)} />
      )}
    </div>
  )
}

// ── ReactedByModal ───────────────────────────────────────────────────────────
// Names-only list of who reacted to a post, grouped by emoji — visible to any community member, no role gate.

function ReactedByModal({ postId, getToken, onClose }) {
  const [groups, setGroups] = useState(null)
  const [error,  setError]  = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/community/posts/${postId}/reactors`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (!cancelled) setGroups(data)
      } catch {
        if (!cancelled) setError(true)
      }
    }
    load()
    return () => { cancelled = true }
  }, [postId, getToken])

  const sections = groups
    ? REACTIONS.filter(({ type }) => groups[type]?.length).map(r => ({ ...r, users: groups[r.type] }))
    : []

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-sm shadow-xl overflow-hidden max-h-[70vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <h2 className="text-base font-bold text-gray-900">Reactions</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="overflow-y-auto px-2 py-2">
          {groups === null && !error && (
            <p className="text-center text-sm text-gray-400 py-6">Loading…</p>
          )}
          {error && (
            <p className="text-center text-sm text-gray-400 py-6">Couldn't load reactions.</p>
          )}
          {groups && sections.length === 0 && (
            <p className="text-center text-sm text-gray-400 py-6">No reactions yet.</p>
          )}
          {sections.map(({ type, emoji, users }) => (
            <div key={type} className="mb-1">
              <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                <span className="text-sm">{emoji}</span>
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{type}</span>
              </div>
              {users.map(u => {
                const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Member'
                return (
                  <div key={`${type}-${u.id}`} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50">
                    <Avatar name={u.first_name} size="sm" />
                    <span className="text-sm text-gray-800">{name}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── LikedByModal ──────────────────────────────────────────────────────────────
// Names-only list of who liked a post — visible to any community member, no role gate.

function LikedByModal({ postId, getToken, onClose }) {
  const [likers, setLikers] = useState(null)
  const [error,  setError]  = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/community/posts/${postId}/likers`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (!cancelled) setLikers(data)
      } catch {
        if (!cancelled) setError(true)
      }
    }
    load()
    return () => { cancelled = true }
  }, [postId, getToken])

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-sm shadow-xl overflow-hidden max-h-[70vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <h2 className="text-base font-bold text-gray-900">Liked by</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="overflow-y-auto px-2 py-2">
          {likers === null && !error && (
            <p className="text-center text-sm text-gray-400 py-6">Loading…</p>
          )}
          {error && (
            <p className="text-center text-sm text-gray-400 py-6">Couldn't load likes.</p>
          )}
          {likers?.length === 0 && (
            <p className="text-center text-sm text-gray-400 py-6">No likes yet.</p>
          )}
          {likers?.map(u => {
            const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Member'
            return (
              <div key={u.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50">
                <Avatar name={u.first_name} size="sm" />
                <span className="text-sm text-gray-800">{name}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

function Leaderboard({ getToken }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/community/leaderboard`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setEntries(await res.json())
      } catch {}
      setLoading(false)
    }
    load()
  }, [getToken])

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sticky top-0">
      <h3 className="text-sm font-bold text-gray-900 mb-1">🏆 Top This Week</h3>
      <p className="text-xs text-gray-400 mb-3">Meal logging streak</p>
      {loading && <p className="text-xs text-gray-400 py-4 text-center">Loading…</p>}
      {!loading && entries.length === 0 && (
        <p className="text-xs text-gray-400 py-4 text-center">No logs this week yet.</p>
      )}
      <div className="space-y-2.5">
        {entries.map((entry, i) => (
          <div key={entry.id} className="flex items-center gap-2">
            <span className="text-xs w-5 text-center shrink-0 font-bold">
              {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : <span className="text-gray-400">{i + 1}</span>}
            </span>
            <Avatar name={entry.first_name} size="sm" />
            <span className="text-xs text-gray-800 flex-1 truncate font-medium">{entry.first_name ?? 'Member'}</span>
            <span className="text-xs font-semibold shrink-0" style={{ color: 'var(--color-accent)' }}>{entry.streak}d</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── HybridTab ─────────────────────────────────────────────────────────────────

function HybridTab({ getToken, isAdmin, isStaff, channel, currentUserId }) {
  const photoInputRef = useRef(null)
  const [posts,          setPosts]         = useState([])
  const [hasMore,        setHasMore]       = useState(false)
  const [nextBeforeId,   setNextBeforeId]  = useState(null)
  const [loadingOlder,   setLoadingOlder]  = useState(false)
  const [loading,        setLoading]       = useState(true)
  const [error,          setError]         = useState(null)
  const [retryKey,       setRetryKey]      = useState(0)
  const [newPost,        setNewPost]       = useState('')
  const [poll,           setPoll]          = useState(null)
  const [photo,          setPhoto]         = useState(null)
  const [preview,        setPreview]       = useState(null)
  const [posting,        setPosting]       = useState(false)
  const [search,         setSearch]        = useState('')
  const [searchParams]                     = useSearchParams()
  const [highlightPostId, setHighlightPostId] = useState(null) // post_id deep link target, briefly highlighted
  const [groups,          setGroups]        = useState([]) // org's community_groups — backs the post-edit category dropdown
  const [manageGroupsOpen, setManageGroupsOpen] = useState(false)
  const [myGroups,        setMyGroups]      = useState([])          // pill row: groups the caller belongs to
  const [myGroupsLoaded,  setMyGroupsLoaded]= useState(false)       // gates deep-link group resolution below
  const [activeGroupId,   setActiveGroupId] = useState(null)        // null until myGroups loads, then always a real group id
  const [deepLinkGroupId, setDeepLinkGroupId] = useState(undefined) // undefined = unresolved, null = no group (unavailable), number = group id
  const [deepLinkError,   setDeepLinkError]   = useState(null)
  const [savedView,       setSavedView]       = useState(false) // Saved pill toggled on — feed swaps to GET /posts/saved instead of the active group
  const [savedPosts,      setSavedPosts]      = useState([])
  const [savedLoading,    setSavedLoading]    = useState(false)
  const [savedError,      setSavedError]      = useState(null)

  const activeGroup = myGroups.find(g => g.id === activeGroupId) ?? myGroups[0] ?? null
  const groupParam  = activeGroup ? String(activeGroup.id) : null

  // Falls back to the old hardcoded list until groups load (or if the fetch
  // fails) so the composer/filter dropdowns are never empty.
  const groupNames = groups.length ? groups.map(g => g.name) : CATEGORIES

  const loadGroups = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/groups`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setGroups(await res.json())
    } catch {}
  }, [getToken])

  useEffect(() => { loadGroups() }, [loadGroups])

  // Pill row source. Falls back to an empty row on failure rather than
  // fabricating a feed — the "No groups yet" empty state below covers that.
  const loadMyGroups = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/my-groups`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()
      setMyGroups(Array.isArray(data) ? data : [])
    } catch {
      setMyGroups([])
    } finally {
      // Gates the deep-link group lookup below — that check needs the real
      // membership list, not the [] placeholder this state starts as.
      setMyGroupsLoaded(true)
    }
  }, [getToken])

  useEffect(() => { loadMyGroups() }, [loadMyGroups])

  // Defaults activeGroup to the first group on initial load, and re-anchors to
  // the first group if the selected one disappears (removed from the group,
  // or deactivated) instead of polling a 403/empty feed.
  useEffect(() => {
    if (!myGroupsLoaded) return
    if (myGroups.length === 0) { setActiveGroupId(null); return }
    if (!myGroups.some(g => g.id === activeGroupId)) {
      setActiveGroupId(myGroups[0].id)
    }
  }, [myGroups, myGroupsLoaded, activeGroupId])

  // Re-runs on group switch, which clears the feed and resets the before_id
  // cursor — posts from the previous group must never bleed into the new one.
  // Skips the fetch entirely until a real group is selected (myGroups still
  // loading, or empty — the "No groups yet" empty state covers that case).
  useEffect(() => {
    setError(null)
    setPosts([])
    setHasMore(false)
    setNextBeforeId(null)
    if (!groupParam) { setLoading(false); return }
    setLoading(true)
    async function load() {
      try {
        const token = await getToken()
        const res   = await fetch(
          `${API_URL}/api/community/posts?channel=${channel}&group_id=${groupParam}&limit=30`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        const data = await res.json()
        setPosts(data.posts ?? [])
        setHasMore(data.hasMore ?? false)
        setNextBeforeId(data.nextBeforeId ?? null)
      } catch (err) { setError(err.message) }
      finally { setLoading(false) }
    }
    load()
  }, [getToken, channel, retryKey, groupParam])

  // Deep link from a community post push notification: /community?post_id=POST_ID
  // (see notifyNewCommunityPost in server/services/pushService.js and the
  // pushNotificationActionPerformed listener in Layout.jsx).
  //
  // The page always opens on the first group, but the post may live in a
  // different group the feed hasn't loaded (or the caller isn't a member of),
  // so the post_id alone isn't enough — first resolve which group the post
  // belongs to via GET /posts/:id/group, then switch the pill row to that
  // group before the highlight effect below can find it. Runs once per
  // post_id: guarded on deepLinkGroupId still being undefined so it doesn't
  // refire as myGroups changes for unrelated reasons (e.g. after a Manage
  // Members edit).
  useEffect(() => {
    const postId = searchParams.get('post_id')
    if (!postId || !myGroupsLoaded || deepLinkGroupId !== undefined) return
    let cancelled = false
    async function resolve() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/community/posts/${postId}/group`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (cancelled) return
        if (!res.ok) {
          setDeepLinkError('That post could not be found.')
          setDeepLinkGroupId(null)
          return
        }
        const { group_id } = await res.json()
        if (group_id === null) {
          // Legacy ungrouped post — there's no feed left to show it in.
          setDeepLinkError('That post could not be found.')
          setDeepLinkGroupId(null)
          return
        }
        if (myGroups.some(g => g.id === group_id)) {
          setActiveGroupId(group_id)
          setDeepLinkGroupId(group_id)
        } else {
          setDeepLinkError("You don't have access to that post.")
          setDeepLinkGroupId(group_id)
        }
      } catch {
        if (!cancelled) {
          setDeepLinkError('That post could not be found.')
          setDeepLinkGroupId(null)
        }
      }
    }
    resolve()
    return () => { cancelled = true }
  }, [searchParams, myGroupsLoaded, myGroups, getToken, deepLinkGroupId])

  // Scrolls the matching post into view and briefly highlights it, then cleans
  // the URL so the back button and refresh don't retrigger it. Waits for the
  // group resolution above (deepLinkGroupId !== undefined) and for that
  // group's feed to actually finish loading, so it never searches the wrong
  // (pre-switch) posts array. On an access/lookup error, just cleans the URL —
  // the error banner below is the user-facing signal, this effect has nothing
  // to highlight.
  useEffect(() => {
    const postId = searchParams.get('post_id')
    if (!postId) return
    if (deepLinkError) {
      window.history.replaceState({}, '', '/community')
      return
    }
    if (deepLinkGroupId === undefined || loading || posts.length === 0) return
    const numericId = Number(postId)
    if (!posts.some(p => p.id === numericId)) return

    setHighlightPostId(numericId)
    document.getElementById(`post-${numericId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.history.replaceState({}, '', '/community')

    const t = setTimeout(() => setHighlightPostId(null), 2000)
    return () => clearTimeout(t)
  }, [searchParams, posts, loading, deepLinkGroupId, deepLinkError])

  const visiblePosts = posts.filter(p => !search.trim() || p.content.toLowerCase().includes(search.toLowerCase()))
  const visibleSavedPosts = savedPosts.filter(p => !search.trim() || p.content.toLowerCase().includes(search.toLowerCase()))

  function handlePhotoSelect(file) {
    if (!file || !file.type.startsWith('image/')) return
    if (preview) URL.revokeObjectURL(preview)
    setPhoto(file); setPreview(URL.createObjectURL(file))
  }
  function clearPhoto() {
    if (preview) URL.revokeObjectURL(preview)
    setPhoto(null); setPreview(null)
    if (photoInputRef.current) photoInputRef.current.value = ''
  }

  async function submitPost(e) {
    e.preventDefault()
    if (!newPost.trim() || posting || !activeGroup) return
    setPosting(true)
    try {
      const token = await getToken()
      const body  = new FormData()
      body.append('content', newPost.trim())
      // Every post belongs to a group, so the category label always comes
      // from the active group. The server re-derives it from group_id anyway;
      // sending it keeps the optimistic post card correct.
      body.append('category', activeGroup.name)
      body.append('channel', channel)
      body.append('group_id', String(activeGroup.id))
      if (photo) body.append('photo', photo)
      if (poll?.question?.trim() && poll.options.filter(o => o.trim()).length >= 2) {
        body.append('poll_question', poll.question.trim())
        body.append('poll_options', JSON.stringify(poll.options.filter(o => o.trim())))
      }

      const res = await fetch(`${API_URL}/api/community/posts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      })
      if (!res.ok) throw new Error('Failed to post')
      const post = await res.json()
      setPosts(prev => {
        const pinned   = prev.filter(p => p.pinned)
        const unpinned = prev.filter(p => !p.pinned)
        return [...pinned, post, ...unpinned]
      })
      setNewPost(''); setPoll(null); clearPhoto()
    } catch (err) { setError(err.message) }
    finally { setPosting(false) }
  }

  const loadSavedPosts = useCallback(async () => {
    setSavedLoading(true)
    setSavedError(null)
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/community/posts/saved`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()
      setSavedPosts(data.posts ?? [])
    } catch (err) {
      setSavedError(err.message)
    } finally {
      setSavedLoading(false)
    }
  }, [getToken])

  useEffect(() => {
    if (savedView) loadSavedPosts()
  }, [savedView, loadSavedPosts])

  const toggleLike = useCallback(async (postId) => {
    const flip = arr => arr.map(p => {
      if (p.id !== postId) return p
      const liked = !p.liked_by_me
      return { ...p, liked_by_me: liked, like_count: p.like_count + (liked ? 1 : -1) }
    })
    setPosts(flip)
    setSavedPosts(flip)
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/community/posts/${postId}/like`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      const apply = arr => arr.map(p =>
        p.id === postId ? { ...p, liked_by_me: data.liked, like_count: data.like_count } : p
      )
      setPosts(apply)
      setSavedPosts(apply)
    } catch {
      setPosts(flip)
      setSavedPosts(flip)
    }
  }, [getToken])

  // Optimistic bookmark toggle — mirrors toggleLike above. Applied to both the
  // active group feed and the Saved list so a save/unsave stays in sync
  // regardless of which one the user is currently looking at; unsaving while
  // viewing the Saved tab also drops the post from that list immediately
  // (it belongs there only while it's the source of truth, on next fetch).
  const toggleSave = useCallback(async (postId, nextSaved) => {
    const applyFlag = arr => arr.map(p => p.id === postId ? { ...p, saved_by_me: nextSaved } : p)
    setPosts(applyFlag)
    setSavedPosts(prev => nextSaved ? applyFlag(prev) : prev.filter(p => p.id !== postId))
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/posts/${postId}/save`, {
        method: nextSaved ? 'POST' : 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error()
    } catch {
      setPosts(arr => arr.map(p => p.id === postId ? { ...p, saved_by_me: !nextSaved } : p))
      if (savedView) loadSavedPosts()
    }
  }, [getToken, savedView, loadSavedPosts])

  const deletePost = useCallback(async (postId) => {
    if (!window.confirm('Delete this post? This cannot be undone.')) return
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/posts/${postId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        setPosts(prev => prev.filter(p => p.id !== postId))
        setSavedPosts(prev => prev.filter(p => p.id !== postId))
      }
    } catch {}
  }, [getToken])

  const pinPost = useCallback(async (postId) => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/posts/${postId}/pin`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const { pinned } = await res.json()
        setPosts(prev => {
          const updated = prev.map(p => ({ ...p, pinned: p.id === postId ? pinned : (pinned ? false : p.pinned) }))
          return [...updated.filter(p => p.pinned), ...updated.filter(p => !p.pinned)]
        })
        setSavedPosts(prev => prev.map(p => ({ ...p, pinned: p.id === postId ? pinned : (pinned ? false : p.pinned) })))
      }
    } catch {}
  }, [getToken])

  const updatePost = useCallback((data) => {
    setPosts(prev => prev.map(p => p.id === data.id ? { ...p, ...data } : p))
    setSavedPosts(prev => prev.map(p => p.id === data.id ? { ...p, ...data } : p))
  }, [])

  const submitComment = useCallback(async (postId, content, parentCommentId = null) => {
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/community/posts/${postId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(parentCommentId ? { content, parent_comment_id: parentCommentId } : { content }),
      })
      if (!res.ok) throw new Error()
      return await res.json()
    } catch { return null }
  }, [getToken])

  const loadOlderPosts = useCallback(async () => {
    if (!nextBeforeId || loadingOlder) return
    setLoadingOlder(true)
    try {
      const token = await getToken()
      const res = await fetch(
        `${API_URL}/api/community/posts?channel=${channel}&group_id=${groupParam}&limit=30&before_id=${nextBeforeId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (res.ok) {
        const data = await res.json()
        setHasMore(data.hasMore ?? false)
        setNextBeforeId(data.nextBeforeId ?? null)
        setPosts(prev => {
          const ids = new Set(prev.map(p => p.id))
          return [...prev, ...(data.posts ?? []).filter(p => !ids.has(p.id))]
        })
      }
    } catch {}
    finally { setLoadingOlder(false) }
  }, [channel, groupParam, nextBeforeId, loadingOlder, getToken])

  return (
    <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 w-full">
        {/* Group pills — the groups this user belongs to, first one selected
            by default. Scrolls horizontally on mobile, wraps on desktop.
            Negative margin lets the row bleed to the screen edge on mobile
            while keeping the tap targets inside the normal padding. */}
        <div className="-mx-4 px-4 sm:mx-0 sm:px-0 mb-3 overflow-x-auto sm:overflow-x-visible">
          <div className="flex sm:flex-wrap gap-2 w-max sm:w-auto">
            {myGroups.map(g => {
              const active = g.id === activeGroupId
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setActiveGroupId(g.id)}
                  aria-current={active ? 'true' : undefined}
                  title={g.description ?? undefined}
                  className={`min-h-[44px] px-4 rounded-full text-sm font-medium whitespace-nowrap shrink-0 transition-colors ${
                    active
                      ? 'text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                  style={active ? { background: 'var(--color-accent)' } : undefined}
                >
                  {g.name}
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => setSavedView(v => !v)}
              aria-current={savedView ? 'true' : undefined}
              className={`min-h-[44px] px-4 rounded-full text-sm font-medium whitespace-nowrap shrink-0 transition-colors inline-flex items-center gap-1.5 ${
                savedView
                  ? 'text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
              style={savedView ? { background: 'var(--color-accent)' } : undefined}
            >
              <span aria-hidden="true">🔖</span>
              Saved
            </button>
          </div>
        </div>

        {/* Deep-link resolution failed — post not found, or not accessible
            (not a member of the group it lives in). The URL is already cleaned
            by the highlight effect above; this just surfaces why nothing
            scrolled/highlighted. */}
        {deepLinkError && (
          <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-3">
            <p className="text-sm text-amber-800">{deepLinkError}</p>
            <button
              type="button"
              onClick={() => setDeepLinkError(null)}
              aria-label="Dismiss"
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-amber-500 hover:text-amber-700 text-lg leading-none shrink-0"
            >
              ×
            </button>
          </div>
        )}

        {isAdmin && !savedView && (
          <div className="flex items-center mb-3">
            <button
              type="button"
              onClick={() => setManageGroupsOpen(true)}
              className="ml-auto min-h-[44px] inline-flex items-center gap-1.5 border border-gray-200 text-gray-600 px-3 py-2 rounded-lg text-sm font-semibold transition-colors shrink-0"
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent)'; e.currentTarget.style.borderColor = 'var(--color-accent)' }}
              onMouseLeave={e => { e.currentTarget.style.color = ''; e.currentTarget.style.borderColor = '' }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Manage Groups
            </button>
          </div>
        )}

        {savedView ? (
          <>
          {/* Search */}
          <div className="relative mb-3">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search saved posts…"
              className="w-full border border-gray-200 rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none bg-white"
              onFocus={e => { e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent)' }}
              onBlur={e => { e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>

          {savedError && !savedLoading && (
            <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-8 text-center mb-4">
              <p className="text-2xl mb-2">⚠️</p>
              <p className="text-sm font-semibold text-gray-700 mb-1">Could not load saved posts</p>
              <p className="text-xs text-gray-500 mb-4">There was a problem connecting to the community. Check your connection and try again.</p>
              <button
                onClick={loadSavedPosts}
                className="inline-flex items-center gap-1.5 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-colors"
                style={{ background: 'var(--color-accent)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
              >
                Try again
              </button>
            </div>
          )}
          {savedLoading && <p className="text-sm text-gray-400 text-center py-16">Loading…</p>}

          {!savedLoading && !savedError && visibleSavedPosts.length === 0 && (
            <div className="text-center py-16">
              {savedPosts.length === 0 ? (
                <>
                  <p className="text-2xl mb-3">🔖</p>
                  <p className="text-sm font-semibold text-gray-700 mb-1">No saved posts yet</p>
                  <p className="text-sm text-gray-400">Tap the bookmark icon on a post to save it for later.</p>
                </>
              ) : (
                <>
                  <p className="text-2xl mb-3">🔍</p>
                  <p className="text-sm font-semibold text-gray-700 mb-1">No posts match</p>
                  <p className="text-sm text-gray-400">Try a different search.</p>
                </>
              )}
            </div>
          )}

          <div className="space-y-3">
            {visibleSavedPosts.map(post => (
              <PostCard
                key={post.id}
                post={post}
                onLike={toggleLike}
                onToggleSave={toggleSave}
                onCommentSubmit={submitComment}
                onDeletePost={deletePost}
                onPin={pinPost}
                onUpdate={updatePost}
                getToken={getToken}
                isAdmin={isAdmin}
                isStaff={isStaff}
                currentUserId={currentUserId}
                categories={groupNames}
              />
            ))}
          </div>
          </>
        ) : !myGroupsLoaded ? (
          <p className="text-sm text-gray-400 text-center py-16">Loading…</p>
        ) : myGroups.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-sm font-semibold text-gray-700 mb-1">No groups yet</p>
            <p className="text-sm text-gray-400">
              {isAdmin
                ? 'Create a group above to start the conversation.'
                : "Check back soon, there's nothing here yet."}
            </p>
          </div>
        ) : !activeGroup ? (
          <p className="text-sm text-gray-400 text-center py-16">Loading…</p>
        ) : (
        <>
        {/* Search */}
        <div className="relative mb-3">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search posts…"
            className="w-full border border-gray-200 rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none bg-white"
            onFocus={e => { e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent)' }}
            onBlur={e => { e.currentTarget.style.boxShadow = 'none' }}
          />
        </div>

        {/* Compose */}
        <form onSubmit={submitPost} className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5 mb-5">
          <MentionInput
            value={newPost}
            onChange={setNewPost}
            groupId={activeGroup?.id}
            placeholder="Share a win, ask a question, or check in with the group…"
            rows={3}
            textareaClassName="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm resize-none focus:outline-none min-h-[96px]"
          />

          <p className="mt-3 text-xs text-gray-500">
            Posting to <span className="font-semibold text-gray-700">{activeGroup?.name}</span>
          </p>

          {poll && <PollCreator poll={poll} onChange={setPoll} />}

          {preview && (
            <div className="relative mt-3 rounded-lg overflow-hidden max-h-48">
              <img src={preview} alt="Preview" className="w-full object-cover" />
              <button
                type="button"
                onClick={clearPhoto}
                className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded-lg hover:bg-black/70"
              >
                Remove
              </button>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 mt-3">
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => photoInputRef.current?.click()} className="text-gray-400 transition-colors text-sm" title="Photo"
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.color = '' }}
              >
                📷
              </button>
              <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={e => handlePhotoSelect(e.target.files[0])} />
              {!poll && isAdmin && (
                <button type="button" onClick={() => setPoll({ question: '', options: ['', ''] })} className="text-gray-400 hover:text-blue-500 transition-colors text-sm" title="Poll">
                  📊
                </button>
              )}
            </div>
            <button
              type="submit"
              disabled={!newPost.trim() || posting}
              className="text-white px-5 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0 min-w-[88px]"
              style={{ background: 'var(--color-accent)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
            >
              {posting ? 'Posting…' : 'Post'}
            </button>
          </div>
        </form>

        {error && !loading && (
          <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-8 text-center mb-4">
            <p className="text-2xl mb-2">⚠️</p>
            <p className="text-sm font-semibold text-gray-700 mb-1">Could not load posts</p>
            <p className="text-xs text-gray-500 mb-4">There was a problem connecting to the community. Check your connection and try again.</p>
            <button
              onClick={() => setRetryKey(k => k + 1)}
              className="inline-flex items-center gap-1.5 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-colors"
              style={{ background: 'var(--color-accent)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
            >
              Try again
            </button>
          </div>
        )}
        {loading && <p className="text-sm text-gray-400 text-center py-16">Loading…</p>}

        {!loading && visiblePosts.length === 0 && (
          <div className="text-center py-16">
            {posts.length === 0 ? (
              <>
                <p className="text-2xl mb-3">👋</p>
                <p className="text-sm font-semibold text-gray-700 mb-1">
                  No posts yet. Be the first to post in {activeGroup?.name}.
                </p>
                <p className="text-sm text-gray-400">Share a win, a question, or just say hello.</p>
              </>
            ) : (
              <>
                <p className="text-2xl mb-3">🔍</p>
                <p className="text-sm font-semibold text-gray-700 mb-1">No posts match</p>
                <p className="text-sm text-gray-400">Try a different search or category.</p>
              </>
            )}
          </div>
        )}

        <div className="space-y-3">
          {visiblePosts.map(post => (
            <PostCard
              key={post.id}
              post={post}
              onLike={toggleLike}
              onToggleSave={toggleSave}
              onCommentSubmit={submitComment}
              onDeletePost={deletePost}
              onPin={pinPost}
              onUpdate={updatePost}
              getToken={getToken}
              isAdmin={isAdmin}
              isStaff={isStaff}
              currentUserId={currentUserId}
              categories={groupNames}
              highlighted={post.id === highlightPostId}
            />
          ))}
        </div>
        {hasMore && (
          <div className="text-center mt-4">
            <button
              onClick={loadOlderPosts}
              disabled={loadingOlder}
              className="text-sm text-gray-500 disabled:opacity-40 underline"
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent)' }}
              onMouseLeave={e => { e.currentTarget.style.color = '' }}
            >
              {loadingOlder ? 'Loading…' : 'Load more posts'}
            </button>
          </div>
        )}
        </>
        )}
      </div>

      {manageGroupsOpen && (
        <ManageGroupsModal
          getToken={getToken}
          currentUserId={currentUserId}
          onClose={() => setManageGroupsOpen(false)}
          onGroupsChanged={() => { loadGroups(); loadMyGroups() }}
        />
      )}
    </div>
  )
}

// ── Group management (admin/owner only) ─────────────────────────────────────────

const EMPTY_GROUP = { name: '', description: '', type: 'public' }

// Create/edit form — reused for both via the `initial` prop, same pattern as
// ResourceModal below.
function GroupFormModal({ initial, onSave, onClose, saving }) {
  const [form, setForm] = useState(initial ?? EMPTY_GROUP)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const isEdit  = !!initial?.id
  const canSave = !saving && form.name.trim()

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">{isEdit ? 'Edit Group' : 'New Group'}</h2>
          <button onClick={onClose} className="min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Name *</label>
            <input
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g. Recipe Swap"
              maxLength={100}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none min-h-[44px]"
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
              onBlur={e => { e.currentTarget.style.borderColor = '' }}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Description</label>
            <textarea
              value={form.description ?? ''}
              onChange={e => set('description', e.target.value)}
              rows={3}
              placeholder="What is this group for? (optional)"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none resize-none"
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
              onBlur={e => { e.currentTarget.style.borderColor = '' }}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Visibility</label>
            <div className="flex gap-2">
              {[
                { id: 'public',  label: 'Public',  hint: 'Clients can post here' },
                { id: 'private', label: 'Private', hint: 'Staff only' },
              ].map(t => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => set('type', t.id)}
                  className={`flex-1 min-h-[44px] px-3 py-2 rounded-xl text-sm font-semibold border-2 transition-colors ${
                    form.type === t.id
                      ? 'text-white'
                      : 'border-gray-200 text-gray-600'
                  }`}
                  style={form.type === t.id ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : undefined}
                  onMouseEnter={e => { if (form.type !== t.id) e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                  onMouseLeave={e => { if (form.type !== t.id) e.currentTarget.style.borderColor = '' }}
                  title={t.hint}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="min-h-[44px] px-4 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium">Cancel</button>
          <button
            onClick={() => onSave(form)}
            disabled={!canSave}
            className="min-h-[44px] px-5 py-2 text-white text-sm font-bold rounded-xl disabled:opacity-50 transition-colors"
            style={{ background: 'var(--color-accent)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
          >
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Group'}
          </button>
        </div>
      </div>
    </div>
  )
}

const ROLE_BADGES = {
  admin:         'bg-amber-50 text-amber-700 border-amber-200',
  account_owner: 'bg-amber-50 text-amber-700 border-amber-200',
  coach:         'bg-blue-50 text-blue-700 border-blue-200',
  staff:         'bg-blue-50 text-blue-700 border-blue-200',
  client:        'bg-gray-100 text-gray-600 border-gray-200',
}
function roleLabel(role) {
  return role === 'account_owner' ? 'owner' : (role ?? 'client')
}
function fullName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Member'
}

// Roster editor for one group. Opened per-group from ManageGroupsModal; every
// mutation is re-checked server-side by requireOrgAdminOrOwner, so this is a
// convenience gate, not the security boundary.
// Full-screen on mobile, centered card from sm: up.
function MemberManagementModal({ group, getToken, currentUserId, onClose, onMembershipChanged }) {
  const [members,   setMembers]   = useState(null)
  const [eligible,  setEligible]  = useState(null)
  const [error,     setError]     = useState(null)
  const [query,     setQuery]     = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [busyId,    setBusyId]    = useState(null)  // user_id mid-remove
  const [adding,    setAdding]    = useState(false)
  const changedRef = useRef(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const token = await getToken()
      const headers = { Authorization: `Bearer ${token}` }
      const [mRes, eRes] = await Promise.all([
        fetch(`${API_URL}/api/community/groups/${group.id}/members`,          { headers }),
        fetch(`${API_URL}/api/community/groups/${group.id}/eligible-members`, { headers }),
      ])
      if (!mRes.ok) throw new Error(`Could not load members (${mRes.status})`)
      if (!eRes.ok) throw new Error(`Could not load eligible members (${eRes.status})`)
      setMembers(await mRes.json())
      setEligible(await eRes.json())
    } catch (e) {
      setError(e.message)
      setMembers(m => m ?? [])
      setEligible(e2 => e2 ?? [])
    }
  }, [getToken, group.id])

  useEffect(() => { load() }, [load])

  function close() {
    if (changedRef.current) onMembershipChanged?.()
    onClose()
  }

  async function addMember() {
    const userId = parseInt(selectedId, 10)
    if (!Number.isInteger(userId) || adding) return
    setAdding(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/groups/${group.id}/members`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? 'Could not add member')
      }
      changedRef.current = true
      setSelectedId('')
      setQuery('')
      await load()
    } catch (e) { setError(e.message) }
    finally { setAdding(false) }
  }

  async function removeMember(userId) {
    setBusyId(userId)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/groups/${group.id}/members/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Could not remove member')
      changedRef.current = true
      await load()
    } catch (e) { setError(e.message) }
    finally { setBusyId(null) }
  }

  const q = query.trim().toLowerCase()
  const filteredEligible = (eligible ?? []).filter(u =>
    !q || fullName(u).toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q)
  )
  const loading = members === null || eligible === null

  return (
    <div className="fixed inset-0 z-[60] flex items-stretch sm:items-center justify-center bg-black/50 sm:px-4" onClick={close}>
      <div
        className="bg-white w-full h-full sm:h-auto sm:rounded-2xl sm:max-w-lg shadow-xl overflow-hidden flex flex-col sm:max-h-[85vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 sm:px-6 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900 truncate">Members — {group.name}</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {loading ? 'Loading…' : `${members.length} member${members.length === 1 ? '' : 's'}`}
            </p>
          </div>
          <button
            onClick={close}
            aria-label="Close"
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-gray-600 text-xl leading-none shrink-0"
          >
            ×
          </button>
        </div>

        {error && (
          <div className="mx-5 sm:mx-6 mt-3 bg-red-50 border border-red-200 rounded-xl px-3 py-2 shrink-0">
            <p className="text-xs text-red-600">{error}</p>
          </div>
        )}

        <div className="px-5 sm:px-6 py-4 overflow-y-auto flex-1">
          {loading && <p className="text-sm text-gray-400 text-center py-8">Loading…</p>}

          {!loading && (
            <>
              {/* Add member */}
              <div className="mb-5">
                <label className="block text-xs font-semibold text-gray-700 mb-1">Add a member</label>
                <input
                  type="text"
                  value={query}
                  onChange={e => { setQuery(e.target.value); setSelectedId('') }}
                  placeholder="Search by name or email…"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none min-h-[44px] mb-2"
                  onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                  onBlur={e => { e.currentTarget.style.borderColor = '' }}
                />
                <div className="flex gap-2">
                  <select
                    value={selectedId}
                    onChange={e => setSelectedId(e.target.value)}
                    className="flex-1 min-w-0 border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none bg-white min-h-[44px]"
                    onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                    onBlur={e => { e.currentTarget.style.borderColor = '' }}
                  >
                    <option value="">
                      {error ? 'Unavailable' : filteredEligible.length ? 'Select a person…' : 'No one available to add'}
                    </option>
                    {filteredEligible.map(u => (
                      <option key={u.user_id} value={u.user_id}>
                        {fullName(u)}{u.email ? ` — ${u.email}` : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={addMember}
                    disabled={!selectedId || adding}
                    className="min-h-[44px] px-5 text-white text-sm font-bold rounded-xl disabled:opacity-40 transition-colors shrink-0"
                    style={{ background: 'var(--color-accent)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
                  >
                    {adding ? 'Adding…' : 'Add'}
                  </button>
                </div>
              </div>

              {/* Current members */}
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Current members</p>
              {!error && members.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-6">No members yet. Add someone above.</p>
              )}
              <div className="space-y-1">
                {members.map(m => {
                  const isSelf = m.user_id === currentUserId
                  return (
                    <div key={m.user_id} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                      <Avatar name={m.first_name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-gray-900 truncate">{fullName(m)}</span>
                          <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${ROLE_BADGES[m.role] ?? ROLE_BADGES.client}`}>
                            {roleLabel(m.role)}
                          </span>
                          {isSelf && <span className="text-[10px] text-gray-400">(you)</span>}
                        </div>
                        {m.email && <p className="text-xs text-gray-400 truncate">{m.email}</p>}
                      </div>
                      {/* Removing yourself would drop the group from your own
                          pill row mid-edit, so it's blocked here. */}
                      {!isSelf && (
                        <button
                          type="button"
                          onClick={() => removeMember(m.user_id)}
                          disabled={busyId === m.user_id}
                          aria-label={`Remove ${fullName(m)}`}
                          className="min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-red-500 disabled:opacity-40 text-lg leading-none shrink-0"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        <div className="px-5 sm:px-6 py-4 border-t border-gray-100 flex justify-end shrink-0">
          <button onClick={close} className="min-h-[44px] px-5 py-2 text-sm font-semibold text-gray-600 hover:text-gray-800">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// Full manage-groups panel: list with edit/deactivate, opened from HybridTab's
// "Manage Groups" button (admin/account_owner only — button itself is gated by
// isAdmin, and every mutation is re-checked server-side by requireOrgAdminOrOwner).
function ManageGroupsModal({ getToken, currentUserId, onClose, onGroupsChanged }) {
  const [groups,       setGroups]       = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [formTarget,   setFormTarget]   = useState(null) // null closed | 'new' | group object
  const [saving,       setSaving]       = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting,     setDeleting]     = useState(false)
  const [membersTarget, setMembersTarget] = useState(null) // group whose roster is open

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/groups?all=true`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      setGroups(await res.json())
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [getToken])

  useEffect(() => { load() }, [load])

  async function handleSave(form) {
    setSaving(true)
    try {
      const token = await getToken()
      const isEdit = !!formTarget?.id
      const res = await fetch(
        isEdit ? `${API_URL}/api/community/groups/${formTarget.id}` : `${API_URL}/api/community/groups`,
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: form.name.trim(), description: form.description, type: form.type }),
        },
      )
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? 'Save failed') }
      setFormTarget(null)
      await load()
      onGroupsChanged?.()
    } catch (e) { alert(e.message) }
    finally { setSaving(false) }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/groups/${deleteTarget.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Delete failed')
      setDeleteTarget(null)
      await load()
      onGroupsChanged?.()
    } catch (e) { alert(e.message) }
    finally { setDeleting(false) }
  }

  async function handleReactivate(group) {
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/community/groups/${group.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: group.name, description: group.description, type: group.type, is_active: true }),
      })
      await load()
      onGroupsChanged?.()
    } catch {}
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl overflow-hidden flex flex-col max-h-[85vh]" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-base font-bold text-gray-900">Manage Groups</h2>
            <p className="text-xs text-gray-400 mt-0.5">Categories your community can post into</p>
          </div>
          <button onClick={onClose} className="min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-gray-600 text-xl leading-none shrink-0">×</button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1">
          <button
            type="button"
            onClick={() => setFormTarget('new')}
            className="w-full min-h-[44px] mb-4 inline-flex items-center justify-center gap-2 text-white px-4 py-2 rounded-xl text-sm font-bold transition-colors"
            style={{ background: 'var(--color-accent)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New Group
          </button>

          {loading && <p className="text-sm text-gray-400 text-center py-8">Loading…</p>}
          {error   && <p className="text-sm text-red-500 text-center py-4">{error}</p>}

          {!loading && !error && (
            <div className="space-y-2">
              {groups.map(g => (
                <div key={g.id} className={`border rounded-xl p-3 ${g.is_active ? 'border-gray-200' : 'border-gray-100 bg-gray-50 opacity-60'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-gray-900 truncate">{g.name}</span>
                        {g.type === 'private' && (
                          <span className="text-[10px] font-bold uppercase tracking-wide bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">Staff only</span>
                        )}
                        {!g.is_active && (
                          <span className="text-[10px] font-bold uppercase tracking-wide bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded">Deactivated</span>
                        )}
                      </div>
                      {g.description && <p className="text-xs text-gray-500 mt-0.5">{g.description}</p>}
                      <p className="text-xs text-gray-400 mt-1">{g.post_count} post{g.post_count === 1 ? '' : 's'}</p>
                      <button
                        type="button"
                        onClick={() => setMembersTarget(g)}
                        className="mt-1 min-h-[44px] inline-flex items-center gap-1.5 text-xs font-semibold"
                        style={{ color: 'var(--color-accent)' }}
                        onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-hover)' }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-accent)' }}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                        </svg>
                        Manage Members
                      </button>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {g.is_active ? (
                        <>
                          <button
                            type="button"
                            onClick={() => setFormTarget(g)}
                            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 transition-colors"
                            onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent)' }}
                            onMouseLeave={e => { e.currentTarget.style.color = '' }}
                            title="Edit"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(g)}
                            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors"
                            title="Deactivate"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleReactivate(g)}
                          className="min-h-[44px] px-3 text-xs font-semibold"
                          style={{ color: 'var(--color-accent)' }}
                          onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-hover)' }}
                          onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-accent)' }}
                        >
                          Reactivate
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {groups.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-8">No groups yet. Create one above.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {formTarget !== null && (
        <GroupFormModal
          initial={formTarget === 'new' ? null : formTarget}
          onSave={handleSave}
          onClose={() => setFormTarget(null)}
          saving={saving}
        />
      )}

      {membersTarget && (
        <MemberManagementModal
          group={membersTarget}
          getToken={getToken}
          currentUserId={currentUserId}
          onClose={() => setMembersTarget(null)}
          // Membership changes can add/remove the admin themselves, which
          // changes their own pill row — refresh it on close.
          onMembershipChanged={onGroupsChanged}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-bold text-gray-900 mb-2">Deactivate "{deleteTarget.name}"?</h2>
            <p className="text-sm text-gray-500 mb-5">
              {deleteTarget.post_count > 0
                ? `${deleteTarget.post_count} existing post${deleteTarget.post_count === 1 ? '' : 's'} will keep this category label, but no one will be able to post here anymore. You can reactivate it later.`
                : 'No one will be able to post here anymore. You can reactivate it later.'}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="min-h-[44px] px-4 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium">Cancel</button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="min-h-[44px] px-5 py-2 bg-red-500 text-white text-sm font-bold rounded-xl hover:bg-red-600 disabled:opacity-50 transition-colors"
              >
                {deleting ? 'Deactivating…' : 'Deactivate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Members tab ───────────────────────────────────────────────────────────────

function MembersTab({ members, loading }) {
  return (
    <div className="max-w-2xl">
      {loading && <p className="text-sm text-gray-400 text-center py-16">Loading…</p>}
      {!loading && members.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-16">No members yet.</p>
      )}
      <div className="space-y-3">
        {members.map(m => (
          <div key={m.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-start gap-4">
            <Avatar name={m.first_name} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">{m.first_name ?? 'Member'}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                Joined {new Date(m.created_at).toLocaleDateString([], { month: 'short', year: 'numeric' })}
              </p>
              {m.identity_anchors?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {m.identity_anchors.map((anchor, i) => (
                    <span key={i} className="text-xs bg-[#fde8c8] px-2 py-0.5 rounded-full max-w-xs truncate" style={{ color: 'var(--color-accent-hover)' }}>
                      {anchor}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Mindset Videos helpers ────────────────────────────────────────────────────

// Load YouTube IFrame API once. Guards: no duplicate script tag, onerror, 10s timeout.
let ytApiPromise = null
function loadYTApi() {
  if (window.YT?.Player) return Promise.resolve()
  if (ytApiPromise) return ytApiPromise
  ytApiPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('YT API load timeout')), 10000)
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); if (prev) prev(); resolve() }
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const tag = document.createElement('script')
      tag.src = 'https://www.youtube.com/iframe_api'
      tag.onerror = () => { clearTimeout(timer); reject(new Error('YT script load failed')) }
      document.head.appendChild(tag)
    }
  }).catch(err => { ytApiPromise = null; throw err })  // allow retry on failure
  return ytApiPromise
}

function ytVideoId(url) {
  if (!url) return null
  const short = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/)
  if (short) return short[1]
  const watch = url.match(/[?&]v=([A-Za-z0-9_-]{11})/)
  if (watch) return watch[1]
  const embed = url.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/)
  if (embed) return embed[1]
  return null
}

const EMPTY_VIDEO = { title: '', description: '', youtube_url: '', published: false }

function VideoModal({ initial, onSave, onClose, saving }) {
  const [form, setForm] = useState(initial ?? EMPTY_VIDEO)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const vid = ytVideoId(form.youtube_url)
  const isEdit = !!initial?.id

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl overflow-hidden max-h-[calc(100vh-2rem)]" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">{isEdit ? 'Edit Video' : 'Add Video'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Title *</label>
            <input
              value={form.title}
              onChange={e => set('title', e.target.value)}
              placeholder="Video title"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none"
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
              onBlur={e => { e.currentTarget.style.borderColor = '' }}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">YouTube URL *</label>
            <input
              value={form.youtube_url}
              onChange={e => set('youtube_url', e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none"
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
              onBlur={e => { e.currentTarget.style.borderColor = '' }}
            />
            {form.youtube_url && !vid && (
              <p className="text-xs text-red-500 mt-1">Unrecognised YouTube URL</p>
            )}
            {vid && (
              <img
                src={`https://img.youtube.com/vi/${vid}/mqdefault.jpg`}
                alt="thumbnail"
                className="mt-2 rounded-lg w-full max-w-xs h-auto"
              />
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={e => set('description', e.target.value)}
              rows={3}
              placeholder="Short description (optional)"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none resize-none"
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
              onBlur={e => { e.currentTarget.style.borderColor = '' }}
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.published}
              onChange={e => set('published', e.target.checked)}
              className="w-4 h-4"
              style={{ accentColor: 'var(--color-accent)' }}
            />
            <span className="text-sm font-medium text-gray-700">Published (visible to clients)</span>
          </label>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium">Cancel</button>
          <button
            onClick={() => onSave(form)}
            disabled={saving || !form.title.trim() || !form.youtube_url.trim() || (form.youtube_url && !ytVideoId(form.youtube_url))}
            className="px-5 py-2 text-white text-sm font-bold rounded-xl disabled:opacity-50 transition-colors"
            style={{ background: 'var(--color-accent)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
          >
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Video'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── YoutubePlayer ─────────────────────────────────────────────────────────────
// Standalone component: mount = player starts, unmount = player destroyed.
// React never reconciles inside containerRef — YT owns that subtree entirely.

function YoutubePlayer({ vid, videoId, getToken, onFallback, onProgressSaved }) {
  const containerRef = useRef(null)
  const playerRef    = useRef(null)
  const intervalRef  = useRef(null)
  const sentRef      = useRef(new Set())
  // Stable ref wrappers — the useEffect closure captures these refs, not the values,
  // so YT event handlers always read the latest getToken / callbacks / reportPct.
  const getTokenRef        = useRef(getToken)
  const onFallbackRef      = useRef(onFallback)
  const onProgressSavedRef = useRef(onProgressSaved)
  const reportPctRef       = useRef(null) // set below on every render
  useEffect(() => { getTokenRef.current = getToken }, [getToken])
  useEffect(() => { onFallbackRef.current = onFallback }, [onFallback])
  useEffect(() => { onProgressSavedRef.current = onProgressSaved }, [onProgressSaved])

  function stopTracking() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
  }

  async function reportPct(pct) {
    const gt = getTokenRef.current
    if (!gt) return
    try {
      const token = await gt()
      if (!token) return
      const url = `${API_URL}/api/mindset-videos/${videoId}/progress`
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pct }),
      })
      if (!res.ok) return
      const data = await res.json().catch(() => ({}))
      if (onProgressSavedRef.current) {
        onProgressSavedRef.current(videoId, data.highest_pct ?? pct, Boolean(data.completed))
      }
    } catch { }
  }
  // Always keep reportPctRef pointing at the latest reportPct closure,
  // so YT event handlers set up on mount always call the current version.
  reportPctRef.current = reportPct

  useEffect(() => {
    // Effect runs once on mount; cleanup runs on unmount.
    // No dependency array juggling — lifecycle IS the player lifecycle.
    let cancelled = false

    loadYTApi().then(() => {
      if (cancelled || !containerRef.current) return

      // Create a child div for YT to replace with its iframe.
      // React never touches this div — it has no JSX counterpart.
      const playerDiv = document.createElement('div')
      playerDiv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'
      containerRef.current.innerHTML = ''
      containerRef.current.appendChild(playerDiv)

      playerRef.current = new window.YT.Player(playerDiv, {
        videoId: vid,
        playerVars: {
          autoplay:       1,
          rel:            0,
          modestbranding: 1,
          playsinline:    1,
          enablejsapi:    1,
          origin:         window.location.origin,
        },
        events: {
          onReady: (e) => {
            // Stretch YT's generated iframe to fill the container
            try {
              const iframe = e.target.getIframe()
              if (iframe) iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'
            } catch {}
            if (!sentRef.current.has(1)) { sentRef.current.add(1); reportPctRef.current(1) }
          },
          onStateChange: (e) => {
            if (e.data === window.YT.PlayerState.PLAYING) {
              stopTracking()
              intervalRef.current = setInterval(() => {
                try {
                  const p = playerRef.current
                  if (!p) return
                  const dur = p.getDuration()
                  if (!dur) return
                  const pct = Math.floor(p.getCurrentTime() / dur * 100)
                  for (const m of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
                    if (pct >= m && !sentRef.current.has(m)) {
                      sentRef.current.add(m); reportPctRef.current(m)
                    }
                  }
                } catch {}
              }, 5000)
            } else {
              stopTracking()
            }
            if (e.data === window.YT.PlayerState.ENDED && !sentRef.current.has(100)) {
              sentRef.current.add(100); reportPctRef.current(100)
            }
          },
          onError: () => {},
        },
      })
    }).catch(() => {
      if (!cancelled) {
        if (onFallbackRef.current) onFallbackRef.current()
      }
    })

    return () => {
      cancelled = true
      stopTracking()
      if (playerRef.current) { try { playerRef.current.destroy() } catch {} ; playerRef.current = null }
      if (containerRef.current) containerRef.current.innerHTML = ''
    }
  }, []) // empty deps: runs once on mount, cleaned up on unmount

  return <div ref={containerRef} className="absolute inset-0 w-full h-full" />
}

// ── VideoCard ─────────────────────────────────────────────────────────────────

function VideoCard({ video, isStaff, onEdit, onDelete, onTogglePublish, expanded, onToggleExpand, getToken, progress, onProgressSaved, isAdmin, currentUserId }) {
  const vid = ytVideoId(video.youtube_url)
  const [ytFailed, setYtFailed] = useState(false)

  // Reset fallback when video collapses so next expansion tries the API again
  useEffect(() => { if (!expanded) setYtFailed(false) }, [expanded])

  const statusLabel = !isStaff
    ? progress?.completed
      ? { text: '✓ Completed', cls: 'bg-emerald-100 text-emerald-700' }
      : progress?.started
        ? { text: `In progress · ${Math.round(progress.highest_pct ?? 0)}%`, cls: 'bg-[#fde8c8]', style: { color: 'var(--color-accent-hover)' } }
        : { text: 'Not started', cls: 'bg-gray-100 text-gray-400' }
    : null

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      {/* Thumbnail / player area */}
      <div className="relative bg-black" style={{ aspectRatio: '16/9' }}>
        {expanded && vid ? (
          ytFailed ? (
            /* Fallback: plain embed iframe if YT API fails to load */
            <iframe
              src={`https://www.youtube.com/embed/${vid}?autoplay=1&rel=0&playsinline=1`}
              title={video.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="absolute inset-0 w-full h-full"
            />
          ) : (
            /* YoutubePlayer mounts here; key=vid forces full remount on video change */
            <YoutubePlayer
              key={vid}
              vid={vid}
              videoId={video.id}
              getToken={isStaff ? null : getToken}
              onFallback={() => setYtFailed(true)}
              onProgressSaved={onProgressSaved}
            />
          )
        ) : vid ? (
          <button
            onClick={onToggleExpand}
            className="w-full h-full relative group"
            aria-label="Play video"
          >
            <img
              src={`https://img.youtube.com/vi/${vid}/mqdefault.jpg`}
              alt={video.title}
              className="w-full h-full object-cover"
            />
            {/* Completed overlay */}
            {!isStaff && progress?.completed && (
              <div className="absolute inset-0 flex items-center justify-center bg-emerald-900/50">
                <div className="w-14 h-14 bg-emerald-500 rounded-full flex items-center justify-center shadow-lg">
                  <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
            )}
            {/* Play button (hidden when completed) */}
            {!((!isStaff) && progress?.completed) && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
                <div className="w-14 h-14 rounded-full flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform" style={{ background: 'var(--color-accent)' }}>
                  <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            )}
          </button>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-400 text-sm">No valid YouTube URL</div>
        )}
      </div>

      {/* Info */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              {isStaff && (
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  video.published ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                }`}>
                  {video.published ? 'Published' : 'Draft'}
                </span>
              )}
              {statusLabel && (
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${statusLabel.cls}`} style={statusLabel.style}>
                  {statusLabel.text}
                </span>
              )}
            </div>
            <h3 className="text-sm font-bold text-gray-900 leading-snug">{video.title}</h3>
            {video.description && (
              <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{video.description}</p>
            )}
            {isStaff && <VideoWatchStats videoId={video.id} getToken={getToken} />}
          </div>
          {/* Staff controls */}
          {isStaff && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => onTogglePublish(video)}
                title={video.published ? 'Unpublish' : 'Publish'}
                className={`p-2 rounded-lg text-xs font-semibold transition-colors ${
                  video.published
                    ? 'text-emerald-600 hover:bg-emerald-50'
                    : 'text-gray-400 hover:bg-gray-100'
                }`}
              >
                {video.published ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => onEdit(video)}
                title="Edit"
                className="p-2 rounded-lg text-gray-400 hover:bg-[#fde8c8] transition-colors"
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent)' }}
                onMouseLeave={e => { e.currentTarget.style.color = '' }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
              <button
                onClick={() => onDelete(video)}
                title="Delete"
                className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {!isStaff && (
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              onClick={onToggleExpand}
              className="inline-flex items-center gap-1.5 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors min-h-[36px]"
              style={{ background: 'var(--color-accent)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
            >
              {expanded
                ? 'Close'
                : progress?.completed
                  ? 'Watch again →'
                  : progress?.started
                    ? 'Continue →'
                    : 'Watch →'}
            </button>
          </div>
        )}

        {getToken && (
          <VideoReactionRow videoId={video.id} getToken={getToken} />
        )}

        {getToken && (
          <CommentSection videoId={video.id} getToken={getToken} isAdmin={isAdmin} currentUserId={currentUserId} />
        )}
      </div>
    </div>
  )
}

// ── VideoWatchStats (staff-only aggregate watch counts, one fetch per card) ──
// Reuses the existing GET /coach-admin/mindset-videos/:id/watch-stats endpoint —
// no batch endpoint exists, and the video library here is small/curated (same
// per-card fetch pattern as VideoReactionRow/CommentSection below), so one call
// per rendered card on mount is the right fit rather than adding new plumbing.

function VideoWatchStats({ videoId, getToken }) {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/mindset-videos/${videoId}/watch-stats`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!cancelled && res.ok) setStats(await res.json())
      } catch { /* silent — stats are non-critical to the management list */ }
    }
    load()
    return () => { cancelled = true }
  }, [videoId, getToken])

  // Default to 0s (not blank) so a brand-new video with no watches yet reads
  // cleanly rather than showing nothing while the fetch is in flight.
  const started   = stats?.startedCount   ?? 0
  const watched50 = stats?.watched50Count ?? 0
  const completed = stats?.completedCount ?? 0

  return (
    <p className="text-[11px] text-gray-400 mt-1">
      {started} started · {watched50} watched 50%+ · {completed} completed
    </p>
  )
}

// ── VideoReactionRow (reactions on the video itself, separate from comments) ─

const REACTION_EMOJI = { like: '👍', love: '❤️', fire: '🔥' }

function VideoReactionRow({ videoId, getToken }) {
  const [reactionCounts, setReactionCounts] = useState({})
  const [myReactions, setMyReactions] = useState([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/brain-mapping-comments/${videoId}/video-reactions`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        setReactionCounts(data.reaction_counts ?? {})
        setMyReactions(data.my_reactions ?? [])
        setLoaded(true)
      } catch { /* silent — reaction row is non-critical */ }
    }
    load()
    return () => { cancelled = true }
  }, [videoId, getToken])

  async function handleReact(reactionType) {
    const hasIt = myReactions.includes(reactionType)
    // Optimistic toggle
    setMyReactions(prev => hasIt ? prev.filter(r => r !== reactionType) : [...prev, reactionType])
    setReactionCounts(prev => ({
      ...prev,
      [reactionType]: Math.max(0, (prev[reactionType] ?? 0) + (hasIt ? -1 : 1)),
    }))
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/brain-mapping-comments/${videoId}/video-reactions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reaction_type: reactionType }),
      })
      if (!res.ok) throw new Error()
    } catch {
      // Resync from server on failure
      setMyReactions(prev => hasIt ? [...prev, reactionType] : prev.filter(r => r !== reactionType))
      setReactionCounts(prev => ({
        ...prev,
        [reactionType]: Math.max(0, (prev[reactionType] ?? 0) + (hasIt ? 1 : -1)),
      }))
    }
  }

  if (!loaded) return null

  return (
    <div className="mt-3 flex items-center gap-1.5">
      {Object.keys(REACTION_EMOJI).map(type => {
        const count = reactionCounts[type] ?? 0
        const mine = myReactions.includes(type)
        return (
          <button
            key={type}
            onClick={() => handleReact(type)}
            className={`inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full border transition-colors min-h-[44px] sm:min-h-[32px] ${
              mine ? 'border-transparent' : 'border-gray-200 text-gray-500 hover:bg-gray-100'
            }`}
            style={mine ? { background: '#fde8c8', color: 'var(--color-accent-hover)' } : undefined}
          >
            <span>{REACTION_EMOJI[type]}</span>
            {count > 0 && <span className="font-semibold">{count}</span>}
          </button>
        )
      })}
    </div>
  )
}

// ── CommentSection (Brain Mapping video comments + reactions) ────────────────

function CommentSection({ videoId, getToken, isAdmin, currentUserId }) {
  const [open, setOpen] = useState(false)
  const [comments, setComments] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/brain-mapping-comments/${videoId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      setComments(await res.json())
      setLoaded(true)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  function toggleOpen() {
    const next = !open
    setOpen(next)
    if (next && !loaded) load()
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > 500) return
    setSubmitting(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/brain-mapping-comments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: videoId, comment_text: trimmed }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? 'Failed to post comment') }
      const created = await res.json()
      setComments(prev => [...prev, created])
      setText('')
    } catch (e) { alert(e.message) }
    finally { setSubmitting(false) }
  }

  async function handleDelete(commentId) {
    if (!confirm('Delete this comment?')) return
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/brain-mapping-comments/${commentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to delete comment')
      setComments(prev => prev.filter(c => c.id !== commentId))
    } catch (e) { alert(e.message) }
  }

  async function handleReact(commentId, reactionType) {
    // Optimistic toggle
    setComments(prev => prev.map(c => {
      if (c.id !== commentId) return c
      const mine = c.my_reactions ?? []
      const hasIt = mine.includes(reactionType)
      const counts = { ...(c.reaction_counts ?? {}) }
      counts[reactionType] = Math.max(0, (counts[reactionType] ?? 0) + (hasIt ? -1 : 1))
      return {
        ...c,
        my_reactions: hasIt ? mine.filter(r => r !== reactionType) : [...mine, reactionType],
        reaction_counts: counts,
      }
    }))
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/brain-mapping-comments/${commentId}/reactions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reaction_type: reactionType }),
      })
      if (!res.ok) throw new Error()
    } catch {
      load() // resync on failure
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <button
        onClick={toggleOpen}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-700 min-h-[44px] sm:min-h-0 py-1"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        {loaded ? `${comments.length} ${comments.length === 1 ? 'Comment' : 'Comments'}` : 'Comments'}
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-2 space-y-3">
          {loading && <p className="text-xs text-gray-400 py-2">Loading comments…</p>}
          {error && <p className="text-xs text-red-500 py-2">{error}</p>}

          {!loading && !error && comments.map(c => {
            const canDelete = isAdmin || c.user_id === currentUserId
            return (
              <div key={c.id} className="bg-gray-50 rounded-xl p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-gray-900">{c.user_name ?? 'User'}</p>
                    <p className="text-sm text-gray-700 mt-0.5 break-words">{c.comment_text}</p>
                    <p className="text-[10px] text-gray-400 mt-1">
                      {new Date(c.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </p>
                  </div>
                  {canDelete && (
                    <button
                      onClick={() => handleDelete(c.id)}
                      title="Delete comment"
                      className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0 min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-[32px] flex items-center justify-center"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1.5 mt-2">
                  {Object.keys(REACTION_EMOJI).map(type => {
                    const count = c.reaction_counts?.[type] ?? 0
                    const mine = (c.my_reactions ?? []).includes(type)
                    return (
                      <button
                        key={type}
                        onClick={() => handleReact(c.id, type)}
                        className={`inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full border transition-colors min-h-[32px] ${
                          mine ? 'border-transparent' : 'border-gray-200 text-gray-500 hover:bg-gray-100'
                        }`}
                        style={mine ? { background: '#fde8c8', color: 'var(--color-accent-hover)' } : undefined}
                      >
                        <span>{REACTION_EMOJI[type]}</span>
                        {count > 0 && <span className="font-semibold">{count}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {!loading && !error && loaded && comments.length === 0 && (
            <p className="text-xs text-gray-400 py-1">No comments yet. Be the first to share your thoughts.</p>
          )}

          <form onSubmit={handleSubmit} className="pt-1">
            <textarea
              value={text}
              onChange={e => setText(e.target.value.slice(0, 500))}
              placeholder="Add a comment…"
              rows={2}
              className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 resize-none"
              style={{ '--tw-ring-color': 'var(--color-accent)' }}
              maxLength={500}
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[10px] text-gray-400">{text.length}/500</span>
              <button
                type="submit"
                disabled={!text.trim() || submitting}
                className="inline-flex items-center gap-1.5 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors min-h-[36px] disabled:opacity-40"
                style={{ background: 'var(--color-accent)' }}
                onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = 'var(--color-accent-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
              >
                {submitting ? 'Posting…' : 'Post'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

// ── FeaturedVideoCard (Continue Watching / Start Here) ───────────────────────

function FeaturedVideoCard({ video, progress, label, onWatch }) {
  const vid = ytVideoId(video.youtube_url)
  const pct = Math.min(Math.round(progress?.highest_pct ?? 0), 100)

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden mb-5" style={{ borderTop: '3px solid var(--color-accent)' }}>
      <div className="flex gap-3 p-4">
        {/* Thumbnail */}
        {vid && (
          <button
            onClick={onWatch}
            className="relative rounded-xl overflow-hidden shrink-0 group"
            style={{ width: 112, minHeight: 63 }}
            aria-label={`Play ${video.title}`}
          >
            <img
              src={`https://img.youtube.com/vi/${vid}/mqdefault.jpg`}
              alt={video.title}
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/25 group-hover:bg-black/35 transition-colors">
              <div className="w-9 h-9 rounded-full flex items-center justify-center shadow-md group-hover:scale-110 transition-transform" style={{ background: 'var(--color-accent)' }}>
                <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </div>
          </button>
        )}

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-widest mb-0.5" style={{ color: 'var(--color-accent)' }}>{label}</p>
          <p className="text-sm font-bold text-gray-900 leading-snug line-clamp-2">{video.title}</p>

          {pct > 0 && (
            <div className="mt-2 mb-1">
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--color-accent)' }} />
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">{pct}% watched</p>
            </div>
          )}

          <button
            onClick={onWatch}
            className="mt-2 inline-flex items-center gap-1.5 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors min-h-[36px]"
            style={{ background: 'var(--color-accent)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
          >
            {label === 'Continue Watching' ? 'Continue' : 'Start watching'}
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Mindset tab ───────────────────────────────────────────────────────────────

function MindsetTab({ getToken, isStaff, isAdmin, currentUserId }) {
  const [videos,       setVideos]      = useState([])
  const [myProgress,   setMyProgress]  = useState({})
  const [loading,      setLoading]     = useState(true)
  const [error,        setError]       = useState(null)
  const [modal,        setModal]       = useState(null)  // null | 'add' | videoObj (edit)
  const [saving,       setSaving]      = useState(false)
  const [expandedId,   setExpandedId]  = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting,     setDeleting]    = useState(false)
  const videoRefs                       = useRef({})

  async function load() {
    try {
      const token = await getToken()
      const headers = { Authorization: `Bearer ${token}` }
      const reqs = [fetch(`${API_URL}/api/mindset-videos`, { headers })]
      if (!isStaff) reqs.push(fetch(`${API_URL}/api/mindset-videos/my-progress`, { headers }))
      const [res, progressRes] = await Promise.all(reqs)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      setVideos(await res.json())
      if (progressRes) {
        if (progressRes.ok) {
          setMyProgress(await progressRes.json())
        }
      }
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [getToken])

  // Re-fetch my-progress from the server to sync DB-confirmed state.
  // Called after any progress save so the badge is guaranteed to update.
  const refreshProgressRef = useRef(null)
  refreshProgressRef.current = async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/mindset-videos/my-progress`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setMyProgress(await res.json())
    } catch { }
  }

  const handleProgressSaved = useCallback((videoId, highestPct, completed) => {
    // Optimistic local update for immediate badge feedback
    setMyProgress(prev => {
      const current = prev[videoId] ?? {}
      const nextPct = Math.max(Number(current.highest_pct) || 0, Number(highestPct) || 0)
      return {
        ...prev,
        [videoId]: {
          started: true,
          highest_pct: nextPct,
          completed: Boolean(current.completed || completed || nextPct >= 90),
        },
      }
    })
    // Also re-fetch from server so badge reflects DB-confirmed state
    refreshProgressRef.current?.()
  }, [])

  async function handleSave(form) {
    setSaving(true)
    try {
      const token = await getToken()
      const isEdit = !!modal?.id
      const url = isEdit
        ? `${API_URL}/api/mindset-videos/${modal.id}`
        : `${API_URL}/api/mindset-videos`
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? 'Save failed') }
      setModal(null)
      await load()
    } catch (e) { alert(e.message) }
    finally { setSaving(false) }
  }

  async function handleTogglePublish(video) {
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/mindset-videos/${video.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...video, published: !video.published }),
      })
      await load()
    } catch (e) { alert(e.message) }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/mindset-videos/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      setDeleteTarget(null)
      await load()
    } catch (e) { alert(e.message) }
    finally { setDeleting(false) }
  }

  // Published videos, newest first (client view) — API already returns
  // videos sorted by created_at DESC, but sort defensively here too.
  const publishedVideos = videos
    .filter(v => v.published)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  // Progress summary
  const completedCount = publishedVideos.filter(v => myProgress[v.id]?.completed).length
  const totalCount     = publishedVideos.length
  const progressPct    = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  // Continue Watching: started-but-not-completed, highest pct first (most recent proxy)
  const continueVideo = !isStaff
    ? publishedVideos
        .filter(v => myProgress[v.id]?.started && !myProgress[v.id]?.completed)
        .sort((a, b) => (myProgress[b.id]?.highest_pct ?? 0) - (myProgress[a.id]?.highest_pct ?? 0))[0] ?? null
    : null

  // Start Here: first published uncompleted video when nothing is in progress
  const startHereVideo = (!isStaff && !continueVideo)
    ? publishedVideos.find(v => !myProgress[v.id]?.completed) ?? null
    : null

  const featuredVideo = continueVideo ?? startHereVideo

  function watchFeatured(videoId) {
    setExpandedId(videoId)
    setTimeout(() => {
      videoRefs.current[videoId]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
  }

  return (
    <div className="max-w-2xl">
      {/* ── Staff view ──────────────────────────────────────────────────────── */}
      {isStaff && (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Brain Mapping</h2>
              <p className="text-xs text-gray-400 mt-0.5">Manage videos visible to clients</p>
            </div>
            <button
              onClick={() => setModal('add')}
              className="inline-flex items-center justify-center gap-2 text-white px-4 py-2 rounded-xl text-sm font-bold transition-colors"
              style={{ background: 'var(--color-accent)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add Video
            </button>
          </div>

          {loading && <p className="text-sm text-gray-400 text-center py-16">Loading…</p>}
          {error   && <p className="text-sm text-red-500 text-center py-8">{error}</p>}

          {!loading && !error && videos.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <p className="text-4xl mb-3">🧠</p>
              <p className="text-sm font-semibold text-gray-700 mb-1">No videos yet</p>
              <p className="text-sm text-gray-400">Add your first video with the button above.</p>
            </div>
          )}

          {!loading && !error && videos.length > 0 && (
            <div className="space-y-4">
              {videos.map(v => (
                <VideoCard
                  key={v.id}
                  video={v}
                  isStaff
                  onEdit={setModal}
                  onDelete={setDeleteTarget}
                  onTogglePublish={handleTogglePublish}
                  expanded={expandedId === v.id}
                  onToggleExpand={() => setExpandedId(expandedId === v.id ? null : v.id)}
                  getToken={getToken}
                  isAdmin={isAdmin}
                  currentUserId={currentUserId}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Client view ─────────────────────────────────────────────────────── */}
      {!isStaff && (
        <>
          {/* Page header */}
          <div className="mb-5">
            <h2 className="text-xl font-bold text-gray-900">Brain Mapping</h2>
            <p className="text-sm text-gray-500 mt-0.5">Foundational mindset work from your coaching team.</p>
          </div>

          {loading && <p className="text-sm text-gray-400 text-center py-16">Loading…</p>}
          {error   && <p className="text-sm text-red-500 text-center py-8">{error}</p>}

          {!loading && !error && publishedVideos.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <p className="text-4xl mb-3">🧠</p>
              <p className="text-sm font-semibold text-gray-700 mb-1">No videos yet</p>
              <p className="text-sm text-gray-400">Check back soon — content is on the way.</p>
            </div>
          )}

          {!loading && !error && publishedVideos.length > 0 && (
            <>
              {/* Progress summary bar */}
              {totalCount > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 p-4 mb-5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-gray-600">
                      <span className="font-bold text-gray-900">{completedCount}</span>
                      {' '}of{' '}
                      <span className="font-bold text-gray-900">{totalCount}</span>
                      {' '}completed
                    </span>
                    <span className="text-sm font-bold" style={{ color: 'var(--color-accent)' }}>{progressPct}%</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${progressPct}%`, background: 'var(--color-accent)' }}
                    />
                  </div>
                </div>
              )}

              {/* Continue Watching / Start Here hero */}
              {featuredVideo && (
                <FeaturedVideoCard
                  video={featuredVideo}
                  progress={myProgress[featuredVideo.id] ?? null}
                  label={continueVideo ? 'Continue Watching' : 'Start Here'}
                  onWatch={() => watchFeatured(featuredVideo.id)}
                />
              )}

              {/* Video list, newest first */}
              <div className="space-y-4">
                {publishedVideos.map(v => (
                  <div key={v.id} ref={el => { videoRefs.current[v.id] = el }}>
                    <VideoCard
                      video={v}
                      isStaff={false}
                      onEdit={() => {}}
                      onDelete={() => {}}
                      onTogglePublish={() => {}}
                      expanded={expandedId === v.id}
                      onToggleExpand={() => setExpandedId(expandedId === v.id ? null : v.id)}
                      getToken={getToken}
                      progress={myProgress[v.id] ?? null}
                      onProgressSaved={handleProgressSaved}
                      isAdmin={isAdmin}
                      currentUserId={currentUserId}
                    />
                  </div>
                ))}
              </div>

              {/* Full training library card */}
              <div className="mt-4 bg-gray-100 rounded-xl p-6 flex flex-col sm:flex-row items-center gap-4">
                <div className="w-14 h-14 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--color-sidebar)' }}>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7">
                    <path d="M12 7v14" />
                    <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
                  </svg>
                </div>
                <div className="flex-1 text-center sm:text-left">
                  <h3 className="text-base font-bold text-gray-900">Full Brain Mapping Training Library</h3>
                  <p className="text-sm text-gray-500 mt-1">Access the complete archive of all previous trainings in the Google Docs library.</p>
                </div>
                <a
                  href="https://docs.google.com/document/d/1DxlaTB5tL5TCgpGad2uJLi55NkOsIH2ePKNH67m7IcQ/edit?tab=t.0#heading=h.h552ng7uhtbb"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white px-5 py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2 shrink-0 min-h-[44px] w-full sm:w-auto"
                  style={{ background: 'var(--color-accent)' }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                    <path d="M12 7v14" />
                    <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
                  </svg>
                  Open Full Library
                </a>
              </div>
            </>
          )}
        </>
      )}

      {/* Add/Edit modal */}
      {modal !== null && (
        <VideoModal
          initial={modal === 'add' ? null : modal}
          onSave={handleSave}
          onClose={() => setModal(null)}
          saving={saving}
        />
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-bold text-gray-900 mb-2">Delete video?</h2>
            <p className="text-sm text-gray-500 mb-5">
              "<span className="font-medium text-gray-700">{deleteTarget.title}</span>" will be permanently removed.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium">Cancel</button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-5 py-2 bg-red-500 text-white text-sm font-bold rounded-xl hover:bg-red-600 disabled:opacity-50 transition-colors"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Resources helpers ─────────────────────────────────────────────────────────

const RESOURCE_TYPES = [
  { id: 'link', label: 'Link', icon: '🔗', badge: 'bg-blue-100 text-blue-700' },
  { id: 'file', label: 'File', icon: '📎', badge: 'bg-gray-100 text-gray-700' },
]
function rtype(id) { return id === 'file' ? RESOURCE_TYPES[1] : RESOURCE_TYPES[0] }

const EMPTY_RESOURCE = { title: '', description: '', resource_type: 'link', url: '', category: '', display_order: 0, published: false }

function ResourceModal({ initial, onSave, onClose, saving }) {
  const [form,    setForm]    = useState(initial ?? EMPTY_RESOURCE)
  const [file,    setFile]    = useState(null)
  const fileInputRef           = useRef(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const isEdit  = !!initial?.id
  const isFile  = form.resource_type === 'file'
  const canSave = !saving && form.title.trim() &&
    (isFile ? (file || form.url) : form.url.trim())

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">{isEdit ? 'Edit Resource' : 'Add Resource'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Title *</label>
            <input value={form.title} onChange={e => set('title', e.target.value)} placeholder="Resource title"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none"
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
              onBlur={e => { e.currentTarget.style.borderColor = '' }} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Type</label>
            <div className="flex gap-2">
              {RESOURCE_TYPES.map(t => (
                <button key={t.id} type="button"
                  onClick={() => { set('resource_type', t.id); setFile(null) }}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold border-2 transition-colors ${
                    form.resource_type === t.id
                      ? 'text-white'
                      : 'border-gray-200 text-gray-600'
                  }`}
                  style={form.resource_type === t.id ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : undefined}
                  onMouseEnter={e => { if (form.resource_type !== t.id) e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                  onMouseLeave={e => { if (form.resource_type !== t.id) e.currentTarget.style.borderColor = '' }}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* URL field (Link type) */}
          {!isFile && (
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">URL *</label>
              <input value={form.url} onChange={e => set('url', e.target.value)}
                placeholder="https://drive.google.com/…, https://youtu.be/…, any link"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none"
                onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                onBlur={e => { e.currentTarget.style.borderColor = '' }} />
              <p className="text-xs text-gray-400 mt-1">Google Drive, YouTube, Loom, websites, PDFs — any URL works.</p>
            </div>
          )}

          {/* File upload field */}
          {isFile && (
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">File *</label>
              {isEdit && form.url && !file && (
                <div className="flex items-center gap-2 mb-2 p-2.5 bg-gray-50 rounded-xl border border-gray-200">
                  <span className="text-lg">📎</span>
                  <span className="text-xs text-gray-600 flex-1 truncate">Current file uploaded</span>
                  <button type="button" onClick={() => fileInputRef.current?.click()}
                    className="text-xs font-semibold"
                    style={{ color: 'var(--color-accent)' }}
                    onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-hover)' }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-accent)' }}>Replace</button>
                </div>
              )}
              {file ? (
                <div className="flex items-center gap-2 p-2.5 bg-emerald-50 rounded-xl border border-emerald-200">
                  <span className="text-lg">📎</span>
                  <span className="text-xs text-emerald-700 flex-1 truncate font-medium">{file.name}</span>
                  <button type="button" onClick={() => setFile(null)}
                    className="text-xs text-gray-400 hover:text-gray-600 font-semibold">✕</button>
                </div>
              ) : (!isEdit || !form.url) && (
                <button type="button" onClick={() => fileInputRef.current?.click()}
                  className="w-full border-2 border-dashed border-gray-300 rounded-xl py-5 text-sm text-gray-400 transition-colors"
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-accent)'; e.currentTarget.style.color = 'var(--color-accent)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.color = '' }}>
                  📎 Tap to select file
                </button>
              )}
              <input ref={fileInputRef} type="file" className="hidden"
                accept=".pdf,.doc,.docx,.xls,.xlsx,image/*"
                onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f) }}
              />
              <p className="text-xs text-gray-400 mt-1">PDF, images, Word, Excel (max 20 MB)</p>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Description</label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)}
              rows={3} placeholder="Short description (optional)"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none resize-none"
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
              onBlur={e => { e.currentTarget.style.borderColor = '' }} />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-semibold text-gray-700 mb-1">Category</label>
              <input value={form.category} onChange={e => set('category', e.target.value)} placeholder="e.g. Nutrition"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none"
                onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                onBlur={e => { e.currentTarget.style.borderColor = '' }} />
            </div>
            <div className="w-24">
              <label className="block text-xs font-semibold text-gray-700 mb-1">Order</label>
              <input type="number" value={form.display_order} onChange={e => set('display_order', Number(e.target.value))}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none"
                onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent)' }}
                onBlur={e => { e.currentTarget.style.borderColor = '' }} />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={form.published} onChange={e => set('published', e.target.checked)}
              className="w-4 h-4" style={{ accentColor: 'var(--color-accent)' }} />
            <span className="text-sm font-medium text-gray-700">Published (visible to clients)</span>
          </label>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium">Cancel</button>
          <button onClick={() => onSave(form, file)} disabled={!canSave}
            className="px-5 py-2 text-white text-sm font-bold rounded-xl disabled:opacity-50 transition-colors"
            style={{ background: 'var(--color-accent)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}>
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Resource'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ResourceCard({
  resource, isStaff, onEdit, onDelete, onTogglePublish,
  onMoveUp, onMoveDown, canMoveUp, canMoveDown,
  draggable, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver,
}) {
  const t = rtype(resource.resource_type)
  return (
    <div
      className={`bg-white rounded-2xl border p-4 transition-colors ${
        isDragOver ? 'border-2' : 'border-gray-200'
      }`}
      style={isDragOver ? { borderColor: 'var(--color-accent)' } : undefined}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}>
      <div className="flex items-start gap-3">
        {isStaff && (
          <div className="flex flex-col items-center shrink-0 -ml-1 -my-1">
            <button type="button" onClick={onMoveUp} disabled={!canMoveUp}
              aria-label="Move up"
              className="w-11 h-11 flex items-center justify-center text-gray-400 disabled:opacity-25 transition-colors"
              onMouseEnter={e => { if (canMoveUp) e.currentTarget.style.color = 'var(--color-accent)' }}
              onMouseLeave={e => { e.currentTarget.style.color = '' }}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
              </svg>
            </button>
            <div className="cursor-grab active:cursor-grabbing text-gray-300 select-none -my-1"
              title="Drag to reorder">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
              </svg>
            </div>
            <button type="button" onClick={onMoveDown} disabled={!canMoveDown}
              aria-label="Move down"
              className="w-11 h-11 flex items-center justify-center text-gray-400 disabled:opacity-25 transition-colors"
              onMouseEnter={e => { if (canMoveDown) e.currentTarget.style.color = 'var(--color-accent)' }}
              onMouseLeave={e => { e.currentTarget.style.color = '' }}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        )}
        <div className="text-2xl leading-none shrink-0 mt-0.5">{t.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${t.badge}`}>{t.label}</span>
            {resource.category && (
              <span className="text-xs font-semibold bg-[#fde8c8] px-2 py-0.5 rounded-full" style={{ color: 'var(--color-accent-hover)' }}>{resource.category}</span>
            )}
            {isStaff && (
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                resource.published ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
              }`}>
                {resource.published ? 'Published' : 'Draft'}
              </span>
            )}
          </div>
          <p className="text-sm font-bold text-gray-900 leading-snug">{resource.title}</p>
          {resource.description && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{resource.description}</p>
          )}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <a href={resource.url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold transition-colors"
              style={{ color: 'var(--color-accent)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-accent)' }}>
              Open {t.icon}
            </a>
            {isStaff && (
              <>
                <span className="text-gray-200">|</span>
                <button onClick={() => onTogglePublish(resource)}
                  className={`text-xs font-semibold transition-colors ${
                    resource.published ? 'text-emerald-600 hover:text-emerald-800' : 'text-gray-400 hover:text-gray-600'
                  }`}>
                  {resource.published ? 'Unpublish' : 'Publish'}
                </button>
                <button onClick={() => onEdit(resource)} className="text-xs font-semibold text-gray-400 transition-colors"
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent)' }}
                  onMouseLeave={e => { e.currentTarget.style.color = '' }}>Edit</button>
                <button onClick={() => onDelete(resource)} className="text-xs font-semibold text-gray-400 hover:text-red-500 transition-colors">Delete</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Resources tab ─────────────────────────────────────────────────────────────

function ResourcesTab({ getToken, isStaff }) {
  const [resources,    setResources]    = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [modal,        setModal]        = useState(null)
  const [saving,       setSaving]       = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting,     setDeleting]     = useState(false)

  async function load() {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community-resources`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      setResources(await res.json())
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [getToken])

  async function handleSave(form, file) {
    setSaving(true)
    try {
      const token = await getToken()
      const isEdit = !!modal?.id
      const endpoint = isEdit ? `${API_URL}/api/community-resources/${modal.id}` : `${API_URL}/api/community-resources`
      let res
      if (form.resource_type === 'file' && file) {
        const body = new FormData()
        body.append('file', file)
        body.append('title', form.title)
        body.append('description', form.description ?? '')
        body.append('resource_type', 'file')
        body.append('category', form.category ?? '')
        body.append('display_order', String(form.display_order ?? 0))
        body.append('published', String(form.published ?? false))
        res = await fetch(endpoint, {
          method: isEdit ? 'PUT' : 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body,
        })
      } else {
        res = await fetch(endpoint, {
          method: isEdit ? 'PUT' : 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        })
      }
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? 'Save failed') }
      setModal(null)
      await load()
    } catch (e) { alert(e.message) }
    finally { setSaving(false) }
  }

  async function handleTogglePublish(resource) {
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/community-resources/${resource.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...resource, published: !resource.published }),
      })
      await load()
    } catch (e) { alert(e.message) }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/community-resources/${deleteTarget.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      setDeleteTarget(null)
      await load()
    } catch (e) { alert(e.message) }
    finally { setDeleting(false) }
  }

  // Reordering — optimistic local update, persisted via a single bulk PATCH.
  // dragIndex tracks the item being dragged; dragOverIndex highlights the drop target.
  const [dragIndex,     setDragIndex]     = useState(null)
  const [dragOverIndex, setDragOverIndex] = useState(null)

  async function persistOrder(nextResources) {
    const prev = resources
    setResources(nextResources)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community-resources/reorder`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: nextResources.map(r => r.id) }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      setResources(await res.json())
    } catch (e) {
      setResources(prev)
      alert(e.message || 'Failed to save new order')
    }
  }

  function reorder(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex == null || toIndex == null) return
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= resources.length || toIndex >= resources.length) return
    const next = [...resources]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    persistOrder(next)
  }

  function handleDragStart(index) { setDragIndex(index) }
  function handleDragOver(e, index) { e.preventDefault(); setDragOverIndex(index) }
  function handleDrop(index) {
    reorder(dragIndex, index)
    setDragIndex(null)
    setDragOverIndex(null)
  }
  function handleDragEnd() { setDragIndex(null); setDragOverIndex(null) }

  const grouped = resources.reduce((acc, r) => {
    const key = r.category || 'General'
    if (!acc[key]) acc[key] = []
    acc[key].push(r)
    return acc
  }, {})

  return (
    <div className="max-w-2xl">
      {/* Header */}
      {isStaff ? (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Resources</h2>
            <p className="text-xs text-gray-400 mt-0.5">Manage guides, links, and materials for clients</p>
          </div>
          <button onClick={() => setModal('add')}
            className="inline-flex items-center justify-center gap-2 text-white px-4 py-2 rounded-xl text-sm font-bold transition-colors"
            style={{ background: 'var(--color-accent)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add Resource
          </button>
        </div>
      ) : (
        <div className="mb-5">
          <h2 className="text-lg font-bold text-gray-900">Resources</h2>
          <p className="text-sm text-gray-500 mt-0.5">Guides, links, and materials from your coaching team</p>
        </div>
      )}

      {loading && <p className="text-sm text-gray-400 text-center py-16">Loading…</p>}
      {error   && <p className="text-sm text-red-500 text-center py-8">{error}</p>}

      {!loading && !error && resources.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-4xl mb-3">📚</p>
          <p className="text-sm font-semibold text-gray-700 mb-1">No resources yet</p>
          <p className="text-sm text-gray-400">
            {isStaff ? 'Add your first resource with the button above.' : 'Check back soon — content is on the way.'}
          </p>
        </div>
      )}

      {!loading && !error && resources.length > 0 && (
        isStaff ? (
          <div className="space-y-3">
            {resources.map((r, i) => (
              <ResourceCard key={r.id} resource={r} isStaff
                onEdit={setModal} onDelete={setDeleteTarget} onTogglePublish={handleTogglePublish}
                onMoveUp={() => reorder(i, i - 1)} onMoveDown={() => reorder(i, i + 1)}
                canMoveUp={i > 0} canMoveDown={i < resources.length - 1}
                draggable
                onDragStart={() => handleDragStart(i)}
                onDragOver={e => handleDragOver(e, i)}
                onDrop={() => handleDrop(i)}
                onDragEnd={handleDragEnd}
                isDragOver={dragOverIndex === i && dragIndex !== i} />
            ))}
          </div>
        ) : (
          <div className="space-y-8">
            {Object.entries(grouped).map(([cat, items]) => (
              <div key={cat}>
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">{cat}</h3>
                <div className="space-y-3">
                  {items.map(r => (
                    <ResourceCard key={r.id} resource={r} isStaff={false}
                      onEdit={() => {}} onDelete={() => {}} onTogglePublish={() => {}} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {modal !== null && (
        <ResourceModal initial={modal === 'add' ? null : modal} onSave={handleSave} onClose={() => setModal(null)} saving={saving} />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-bold text-gray-900 mb-2">Delete resource?</h2>
            <p className="text-sm text-gray-500 mb-5">
              "<span className="font-medium text-gray-700">{deleteTarget.title}</span>" will be permanently removed.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium">Cancel</button>
              <button onClick={handleDelete} disabled={deleting}
                className="px-5 py-2 bg-red-500 text-white text-sm font-bold rounded-xl hover:bg-red-600 disabled:opacity-50 transition-colors">
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

// Tab IDs that can be driven by the ?tab= URL param
const VALID_URL_TABS = ['vip', 'ai', 'mindset', 'resources']

export default function Community() {
  const { brandName }                      = useOrgBranding()
  const { getToken }                       = useAuth()
  const { viewing, viewedClient }          = useViewMode()
  const [searchParams]                     = useSearchParams()
  const navigate                           = useNavigate()
  const [isAdmin,        setIsAdmin]       = useState(false)
  const [isStaff,        setIsStaff]       = useState(false)
  const [clientChannel,  setClientChannel] = useState('vip')
  const [currentUserId,  setCurrentUserId] = useState(null)
  const [tab,            setTab]           = useState(null) // set after user loads
  const [initLoading,    setInitLoading]   = useState(true)
  const [initError,      setInitError]     = useState(false)

  const runInit = useCallback(async () => {
    setInitLoading(true)
    setInitError(false)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()
      // /api/users/me is never view-as aware — it always describes the staff
      // member themselves. While viewing, force the client branch throughout
      // (StaffInbox-equivalent admin controls hidden, own-post ownership keyed
      // off the viewed client's id) so this renders the same read-only
      // experience a real client would see, using the viewedClient snapshot
      // captured on "View as this client" for the fields /api/users/me can't give us.
      const staff = !viewing && (data.role === 'admin' || data.role === 'account_owner' || data.role === 'coach' || data.role === 'staff')
      const effectiveCoachingType = viewing ? (viewedClient?.coaching_type ?? 'vip') : data.coaching_type
      // Basic clients have no community access — redirect to dashboard. Applies
      // during view mode too: if the viewed client is basic-tier, staff should
      // see exactly what that client would see, including this redirect.
      if (!staff && effectiveCoachingType === 'basic') {
        navigate('/dashboard', { replace: true })
        return
      }
      const ch = normalizeChannel(effectiveCoachingType)
      setIsAdmin(!viewing && (data.role === 'admin' || data.role === 'account_owner'))
      setIsStaff(staff)
      setClientChannel(ch)
      setCurrentUserId(viewing ? (viewedClient?.id ?? data.id) : data.id)
      // Respect ?tab= URL param (e.g. Brain Mapping sidebar link → ?tab=mindset)
      // Read window.location.search directly to avoid adding searchParams as a
      // callback dependency (which would cause unnecessary re-fetches).
      const urlTab = new URLSearchParams(window.location.search).get('tab')
      const defaultTab = staff ? 'vip' : ch
      setTab((urlTab && VALID_URL_TABS.includes(urlTab)) ? urlTab : defaultTab)
    } catch {
      setInitError(true)
      setTab('vip') // still attempt to show the community
    } finally {
      setInitLoading(false)
    }

    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/community/notifications/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      await fetch(`${API_URL}/api/community/notifications/mark-community-read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {}
  }, [getToken, viewing, viewedClient])

  // Handle sidebar navigation to ?tab=mindset (or any valid tab) while
  // Community is already mounted — React Router won't remount the component,
  // it only updates searchParams.
  useEffect(() => {
    if (tab === null) return // wait for init
    const urlTab = searchParams.get('tab')
    if (urlTab && VALID_URL_TABS.includes(urlTab) && tab !== urlTab) {
      setTab(urlTab)
    }
  }, [searchParams]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    runInit()
  }, [runInit])

  // Build tab list:
  //   Staff/admin — full list: both chat channels, Brain Mapping, Resources
  //   Clients     — Group Chat · Brain Mapping · Resources
  const TABS = isStaff ? [
    { id: 'vip',       label: 'VIP Chat' },
    { id: 'ai',        label: 'AI Chat' },
    { id: 'mindset',   label: 'Brain Mapping' },
    { id: 'resources', label: 'Resources' },
  ] : [
    { id: clientChannel, label: 'Group Chat' },
    { id: 'mindset',     label: 'Brain Mapping' },
    { id: 'resources',   label: 'Resources' },
  ]

  if (initLoading && tab === null) {
    return (
      <div className="max-w-5xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Community</h1>
        <p className="text-sm text-gray-500 mb-6">{`Connect with your ${brandName} community`}</p>
        <div className="flex justify-center py-16">
          <span className="text-sm text-gray-400">Loading…</span>
        </div>
      </div>
    )
  }

  if (initError) {
    return (
      <div className="max-w-5xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Community</h1>
        <p className="text-sm text-gray-500 mb-6">{`Connect with your ${brandName} community`}</p>
        <div className="bg-red-50 border border-red-200 rounded-xl p-8 text-center">
          <p className="text-sm font-medium text-red-700 mb-1">Could not load community settings</p>
          <p className="text-xs text-red-500 mb-4">Check your connection and try again.</p>
          <button
            onClick={runInit}
            className="text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={{ background: 'var(--color-accent)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-accent-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-accent)' }}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  // Brain Mapping is now a normal client tab, so direct ?tab=mindset links
  // use the same tab navigation as the rest of Community.
  const clientOnHiddenTab = false

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Community</h1>
      <p className="text-sm text-gray-500 mb-6">{`Connect with your ${brandName} community`}</p>

      {clientOnHiddenTab ? (
        // Minimal nav when showing Brain Mapping or Resources via sidebar link —
        // just a back-to-chat button so the user isn't stranded
        <div className="mb-6">
          <button
            onClick={() => setTab(clientChannel)}
            className="flex items-center gap-1.5 text-sm font-medium transition-colors"
            style={{ color: 'var(--color-accent)' }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-accent)' }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back to Group Chat
          </button>
        </div>
      ) : (
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 py-2 px-2 rounded-lg text-xs sm:text-sm font-medium transition-colors text-center leading-tight ${
                tab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* While viewing is true every write here already 403s server-side
          (blockWritesInViewMode) — pointer-events-none blocks the click/tap
          before it fires, so the walkthrough reads as read-only instead of a
          pile of failed-request errors. Tab switching above stays live since
          it isn't a write. */}
      <div className={viewing ? 'pointer-events-none select-none' : undefined}>
        {/* Group Chat — VIP or AI channel feed */}
        {(tab === 'vip' || tab === 'ai') && (
          <HybridTab
            key={tab}
            channel={tab}
            getToken={getToken}
            isAdmin={isAdmin}
            isStaff={isStaff}
            currentUserId={currentUserId}
          />
        )}

        {/* Brain Mapping — accessible via sidebar ?tab=mindset link for all users */}
        {tab === 'mindset'   && <MindsetTab getToken={getToken} isStaff={isStaff} isAdmin={isAdmin} currentUserId={currentUserId} />}

        {/* Resources — staff tab + URL-accessible for direct links */}
        {tab === 'resources' && <ResourcesTab getToken={getToken} isStaff={isStaff} />}
      </div>
    </div>
  )
}
