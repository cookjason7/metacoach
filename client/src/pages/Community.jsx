import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { linkify } from '../utils/linkify'
import { API_URL } from '../config.js'

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
  'bg-[#fde8c8] text-[#c45e09]',
  'bg-purple-100 text-purple-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
]
function avatarColor(name) {
  return AVATAR_COLORS[(name?.charCodeAt(0) ?? 0) % AVATAR_COLORS.length]
}
function Avatar({ name, size = 'md' }) {
  const cls = size === 'sm' ? 'w-7 h-7 text-xs' : 'w-9 h-9 text-sm'
  return (
    <div className={`${cls} ${avatarColor(name)} rounded-full flex items-center justify-center font-bold shrink-0`}>
      {name?.[0]?.toUpperCase() ?? '?'}
    </div>
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────

const REACTIONS = [
  { type: 'like',  emoji: '👍', countKey: 'like_count',  myKey: 'my_like'  },
  { type: 'love',  emoji: '❤️', countKey: 'love_count',  myKey: 'my_love'  },
  { type: 'laugh', emoji: '😂', countKey: 'laugh_count', myKey: 'my_laugh' },
]

const CATEGORIES        = ['General Discussion', 'Announcements', 'Non-Scale Victories', 'Hurdles']
const CLIENT_CATEGORIES = ['General Discussion', 'Non-Scale Victories']

const CATEGORY_STYLES = {
  'General Discussion':  'bg-gray-100 text-gray-600 border-gray-200',
  'Announcements':       'bg-amber-50 text-amber-700 border-amber-200',
  'Non-Scale Victories': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Hurdles':             'bg-rose-50 text-rose-700 border-rose-200',
}

// ── MentionInput ──────────────────────────────────────────────────────────────

function MentionInput({ value, onChange, members, placeholder, rows = 3, inputClassName, textareaClassName }) {
  const ref   = useRef(null)
  const [query,  setQuery]  = useState(null)
  const [atPos,  setAtPos]  = useState(0)

  function handleChange(e) {
    onChange(e.target.value)
    const el     = e.target
    const cursor = el.selectionStart
    const before = el.value.slice(0, cursor)
    const match  = before.match(/(?<!\w)@([A-Za-z]\w*)$/)
    if (match) { setQuery(match[1].toLowerCase()); setAtPos(cursor - match[0].length) }
    else setQuery(null)
  }

  function pick(name) {
    const el     = ref.current
    const cursor = el.selectionStart
    const before = value.slice(0, atPos)
    const after  = value.slice(cursor)
    onChange(`${before}@${name} ${after}`)
    setQuery(null)
    setTimeout(() => {
      el.focus()
      const pos = atPos + name.length + 2
      el.setSelectionRange(pos, pos)
    }, 0)
  }

  const suggestions = query !== null
    ? (members ?? []).filter(m => m.first_name?.toLowerCase().startsWith(query)).slice(0, 5)
    : []

  const isTextarea = rows > 1

  return (
    <div className="relative">
      {isTextarea ? (
        <textarea
          ref={ref}
          rows={rows}
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          className={textareaClassName}
        />
      ) : (
        <input
          ref={ref}
          type="text"
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          className={inputClassName}
        />
      )}
      {suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 mb-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-20">
          {suggestions.map(m => (
            <button
              key={m.id}
              type="button"
              onMouseDown={e => { e.preventDefault(); pick(m.first_name) }}
              className="flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-gray-50 text-left"
            >
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${avatarColor(m.first_name)}`}>
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
                isMyVote ? 'border-[#E8670A] bg-orange-50' : 'border-gray-200'
              } ${!voted ? 'hover:border-gray-300 cursor-pointer' : 'cursor-default'}`}
            >
              <div className="flex justify-between mb-1">
                <span className={isMyVote ? 'text-[#E8670A] font-medium' : 'text-gray-800'}>
                  {opt.option_text}{isMyVote ? ' ✓' : ''}
                </span>
                {voted && <span className="text-xs text-gray-500">{pct}%</span>}
              </div>
              {voted && (
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${isMyVote ? 'bg-[#E8670A]' : 'bg-gray-400'}`}
                    style={{ width: `${pct}%` }}
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

function CommentItem({ comment, getToken, isAdmin, onDelete, members }) {
  const [reactions, setReactions] = useState({
    like_count:  comment.like_count  ?? 0,
    love_count:  comment.love_count  ?? 0,
    laugh_count: comment.laugh_count ?? 0,
    my_like:     comment.my_like     ?? false,
    my_love:     comment.my_love     ?? false,
    my_laugh:    comment.my_laugh    ?? false,
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
          my_like:     data.userReactions?.includes('like')  ?? r.my_like,
          my_love:     data.userReactions?.includes('love')  ?? r.my_love,
          my_laugh:    data.userReactions?.includes('laugh') ?? r.my_laugh,
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
          [myKey]: data.active,
        }))
      }
    } catch {
      setReactions(r => ({ ...r, [myKey]: was, [countKey]: r[countKey] + (was ? 1 : -1) }))
    }
  }

  return (
    <div className="flex gap-2.5 py-2">
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
                reactions[myKey] ? 'text-[#E8670A] font-semibold' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <span>{emoji}</span>
              <span>{reactions[countKey]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── PostCard ──────────────────────────────────────────────────────────────────

function PostCard({ post, onLike, onCommentSubmit, onDeletePost, onPin, onUpdate, getToken, isAdmin, isStaff, currentUserId, members }) {
  const [expanded,       setExpanded]       = useState(false)
  const [comments,       setComments]       = useState(null)
  const [loadingComments,setLoadingComments]= useState(false)
  const [commentText,    setCommentText]    = useState('')
  const [submitting,     setSubmitting]     = useState(false)
  const [localCount,     setLocalCount]     = useState(post.comment_count)
  const [postReactions,  setPostReactions]  = useState({
    like_count: 0, love_count: 0, laugh_count: 0,
    my_like: false, my_love: false, my_laugh: false,
  })
  const [isEditing,      setIsEditing]      = useState(false)
  const [editContent,    setEditContent]    = useState(post.content)
  const [editCategory,   setEditCategory]   = useState(post.category ?? CATEGORIES[0])
  const [saving,         setSaving]         = useState(false)

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
          my_like:     data.userReactions?.includes('like')  ?? false,
          my_love:     data.userReactions?.includes('love')  ?? false,
          my_laugh:    data.userReactions?.includes('laugh') ?? false,
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
          [myKey]: data.active,
        }))
      }
    } catch {
      setPostReactions(r => ({ ...r, [myKey]: was, [countKey]: r[countKey] + (was ? 1 : -1) }))
    }
  }

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

  async function deleteComment(commentId) {
    if (!window.confirm('Delete this comment?')) return
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/comments/${commentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        setComments(prev => prev.filter(c => c.id !== commentId))
        setLocalCount(c => c - 1)
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
    <div className={`bg-white rounded-xl border overflow-hidden ${post.pinned ? 'border-amber-300' : 'border-gray-200'}`}>
      {post.pinned && (
        <div className="flex items-center gap-1.5 px-5 py-2 bg-amber-50 border-b border-amber-200">
          <span className="text-xs">📌</span>
          <span className="text-xs font-medium text-amber-700">Pinned post</span>
        </div>
      )}

      <div className="p-5">
        {/* Header */}
        <div className="flex items-center gap-3 mb-3">
          <Avatar name={post.first_name} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-gray-900">{post.first_name ?? 'Member'}</p>
              {post.hot && <span title="Trending" className="text-sm leading-none">🔥</span>}
            </div>
            <p className="text-xs text-gray-400">{timeAgo(post.created_at)}</p>
          </div>
          {catStyle && !isEditing && (
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${catStyle}`}>
              {post.category}
            </span>
          )}
          <div className="flex items-center gap-2 shrink-0">
            {canEdit && (
              <button
                onClick={() => { setIsEditing(e => !e); setEditContent(post.content); setEditCategory(post.category ?? CATEGORIES[0]) }}
                className="text-xs text-gray-400 hover:text-gray-700 transition-colors"
              >
                {isEditing ? 'Cancel' : 'Edit'}
              </button>
            )}
            {isAdmin && (
              <>
                <button onClick={() => onPin(post.id)} className="text-xs text-amber-500 hover:text-amber-700 transition-colors">
                  {post.pinned ? 'Unpin' : 'Pin'}
                </button>
                <button onClick={() => onDeletePost(post.id)} className="text-xs text-red-400 hover:text-red-600 transition-colors">
                  Delete
                </button>
              </>
            )}
          </div>
        </div>

        {/* Content or edit form */}
        {isEditing ? (
          <div className="mb-3">
            <textarea
              rows={3}
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none mb-2"
            />
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <select
                value={editCategory}
                onChange={e => setEditCategory(e.target.value)}
                className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
              >
                {(isStaff ? CATEGORIES : CLIENT_CATEGORIES).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={saveEdit}
                disabled={saving || !editContent.trim()}
                className="bg-[#E8670A] text-white px-4 py-1.5 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-40 transition-colors"
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
            <button
              key={type}
              onClick={() => togglePostReaction(type)}
              className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors ${
                postReactions[myKey] ? 'text-[#E8670A] font-semibold' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <span>{emoji}</span>
              <span>{postReactions[countKey]}</span>
            </button>
          ))}
        </div>

        {/* Like + comment bar */}
        <div className="flex items-center gap-5 pt-3 border-t border-gray-100">
          <button
            onClick={() => onLike(post.id)}
            className={`flex items-center gap-1.5 text-sm transition-colors ${
              post.liked_by_me ? 'text-rose-500' : 'text-gray-400 hover:text-rose-400'
            }`}
          >
            <span>{post.liked_by_me ? '♥' : '♡'}</span>
            <span>{post.like_count}</span>
          </button>
          <button
            onClick={toggleComments}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-[#c45e09] transition-colors"
          >
            <span>💬</span>
            <span>{localCount}</span>
          </button>
        </div>

        {/* Comments */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            {loadingComments && <p className="text-xs text-gray-400 py-2">Loading…</p>}
            {comments?.length === 0 && !loadingComments && (
              <p className="text-xs text-gray-400 py-1">No comments yet. Be the first.</p>
            )}
            {comments?.map(c => (
              <CommentItem key={c.id} comment={c} getToken={getToken} isAdmin={isAdmin} onDelete={deleteComment} members={members} />
            ))}
            <form onSubmit={submitComment} className="flex gap-2 mt-3">
              <MentionInput
                value={commentText}
                onChange={setCommentText}
                members={members}
                placeholder="Add a comment…"
                rows={1}
                inputClassName="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
              <button
                type="submit"
                disabled={!commentText.trim() || submitting}
                className="bg-[#E8670A] text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-40 transition-colors"
              >
                Post
              </button>
            </form>
          </div>
        )}
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
            <span className="text-xs font-semibold text-[#E8670A] shrink-0">{entry.streak}d</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── HybridTab ─────────────────────────────────────────────────────────────────

function HybridTab({ getToken, isAdmin, isStaff, currentUserId, members }) {
  const photoInputRef = useRef(null)
  const [posts,          setPosts]         = useState([])
  const [loading,        setLoading]       = useState(true)
  const [error,          setError]         = useState(null)
  const [newPost,        setNewPost]       = useState('')
  const [category,       setCategory]      = useState(CATEGORIES[0])
  const [poll,           setPoll]          = useState(null)
  const [photo,          setPhoto]         = useState(null)
  const [preview,        setPreview]       = useState(null)
  const [posting,        setPosting]       = useState(false)
  const [search,         setSearch]        = useState('')
  const [activeCategory, setActiveCategory]= useState('All')

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/community/posts`, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        setPosts(await res.json())
      } catch (err) { setError(err.message) }
      finally { setLoading(false) }
    }
    load()
  }, [getToken])

  const visiblePosts = posts.filter(p => {
    const matchSearch = !search.trim() || p.content.toLowerCase().includes(search.toLowerCase())
    const matchCat    = activeCategory === 'All' || p.category === activeCategory
    return matchSearch && matchCat
  })

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
    if (!newPost.trim() || posting) return
    setPosting(true)
    try {
      const token = await getToken()
      const body  = new FormData()
      body.append('content', newPost.trim())
      body.append('category', category)
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
      setNewPost(''); setCategory(CATEGORIES[0]); setPoll(null); clearPhoto()
    } catch (err) { setError(err.message) }
    finally { setPosting(false) }
  }

  const toggleLike = useCallback(async (postId) => {
    setPosts(prev => prev.map(p => {
      if (p.id !== postId) return p
      const liked = !p.liked_by_me
      return { ...p, liked_by_me: liked, like_count: p.like_count + (liked ? 1 : -1) }
    }))
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/community/posts/${postId}/like`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setPosts(prev => prev.map(p =>
        p.id === postId ? { ...p, liked_by_me: data.liked, like_count: data.like_count } : p
      ))
    } catch {
      setPosts(prev => prev.map(p => {
        if (p.id !== postId) return p
        const liked = !p.liked_by_me
        return { ...p, liked_by_me: liked, like_count: p.like_count + (liked ? 1 : -1) }
      }))
    }
  }, [getToken])

  const deletePost = useCallback(async (postId) => {
    if (!window.confirm('Delete this post? This cannot be undone.')) return
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/community/posts/${postId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setPosts(prev => prev.filter(p => p.id !== postId))
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
      }
    } catch {}
  }, [getToken])

  const updatePost = useCallback((data) => {
    setPosts(prev => prev.map(p => p.id === data.id ? { ...p, ...data } : p))
  }, [])

  const submitComment = useCallback(async (postId, content) => {
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/community/posts/${postId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) throw new Error()
      return await res.json()
    } catch { return null }
  }, [getToken])

  return (
    <div className="flex flex-col lg:flex-row gap-6 items-start">
      <div className="flex-1 min-w-0 w-full">
        {/* Search */}
        <div className="relative mb-3">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search posts…"
            className="w-full border border-gray-200 rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
          />
        </div>

        {/* Category filter tabs */}
        <div className="flex gap-1.5 flex-wrap mb-4">
          {['All', ...CATEGORIES].map(cat => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeCategory === cat
                  ? 'bg-[#E8670A] text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A]'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Compose */}
        <form onSubmit={submitPost} className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
          <MentionInput
            value={newPost}
            onChange={setNewPost}
            members={members}
            placeholder="Share a win, ask a question, or check in with the group…"
            rows={3}
            textareaClassName="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />

          {/* Category dropdown */}
          <div className="flex items-center gap-3 mt-3">
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white flex-1"
            >
              {(isStaff ? CATEGORIES : CLIENT_CATEGORIES).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

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

          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => photoInputRef.current?.click()} className="text-gray-400 hover:text-[#c45e09] transition-colors text-sm" title="Photo">
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
              className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {posting ? 'Posting…' : 'Post'}
            </button>
          </div>
        </form>

        {error && <p className="text-sm text-red-500 text-center mb-4">{error}</p>}
        {loading && <p className="text-sm text-gray-400 text-center py-16">Loading…</p>}

        {!loading && visiblePosts.length === 0 && (
          <div className="text-center py-16">
            {posts.length === 0 ? (
              <>
                <p className="text-2xl mb-3">👋</p>
                <p className="text-sm font-semibold text-gray-700 mb-1">Be the first to post</p>
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

        <div className="space-y-4">
          {visiblePosts.map(post => (
            <PostCard
              key={post.id}
              post={post}
              onLike={toggleLike}
              onCommentSubmit={submitComment}
              onDeletePost={deletePost}
              onPin={pinPost}
              onUpdate={updatePost}
              getToken={getToken}
              isAdmin={isAdmin}
              isStaff={isStaff}
              currentUserId={currentUserId}
              members={members}
            />
          ))}
        </div>
      </div>

      {/* Leaderboard sidebar */}
      <div className="w-full lg:w-52 shrink-0">
        <Leaderboard getToken={getToken} />
      </div>
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
                {m.streak > 0 && ` · 🔥 ${m.streak}d streak`}
              </p>
              {m.identity_anchors?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {m.identity_anchors.map((anchor, i) => (
                    <span key={i} className="text-xs bg-[#fde8c8] text-[#c45e09] px-2 py-0.5 rounded-full max-w-xs truncate">
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

// ── Classroom tab ─────────────────────────────────────────────────────────────

function ClassroomTab() {
  return (
    <div className="max-w-2xl">
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
        <div className="px-6 py-5" style={{ background: 'linear-gradient(135deg, #0F1E35 0%, #1e3a5f 100%)' }}>
          <p className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-1">Module 1</p>
          <h2 className="text-xl font-bold text-white mb-2">Brain Mapping</h2>
          <p className="text-sm text-white/70 leading-relaxed">
            Rewire your relationship with food and your body at the identity level.
            This is the foundational work that makes everything else stick.
          </p>
        </div>
        <div className="p-6">
          <p className="text-sm text-gray-600 leading-relaxed mb-5">
            Brain Mapping is the core methodology behind Life Warrior Coaching.
            Before you change your plate, you change your mind. This module walks you
            through the identity shift that separates women who transform from women who cycle.
          </p>
          <a
            href="https://www.lwcvip.com/mindset"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block bg-[#E8670A] text-white px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-[#c45e09] transition-colors"
          >
            Start Brain Mapping →
          </a>
        </div>
      </div>

      <div className="flex flex-col items-center justify-center py-12 text-center text-gray-400">
        <p className="text-3xl mb-3">📚</p>
        <p className="text-sm font-semibold text-gray-600 mb-1">More courses coming soon</p>
        <p className="text-sm">New content drops regularly. Check back often.</p>
      </div>
    </div>
  )
}

// ── Resources tab ─────────────────────────────────────────────────────────────

function ResourcesTab() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center max-w-2xl">
      <div className="text-5xl mb-4">📚</div>
      <h2 className="text-lg font-semibold text-gray-800 mb-2">Resources</h2>
      <p className="text-sm text-gray-500 max-w-xs">
        Guides, templates, and reference materials from your coaching team. Coming soon.
      </p>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Community() {
  const { getToken }                       = useAuth()
  const [tab,            setTab]           = useState('chat')
  const [isAdmin,        setIsAdmin]       = useState(false)
  const [isStaff,        setIsStaff]       = useState(false)
  const [clientChannel,  setClientChannel] = useState('vip')
  const [currentUserId,  setCurrentUserId] = useState(null)
  const [members,        setMembers]       = useState([])
  const [membersLoading, setMembersLoading]= useState(true)

  useEffect(() => {
    async function init() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) return
        const data = await res.json()
        const staff = data.role === 'admin' || data.role === 'coach'
        setIsAdmin(data.role === 'admin')
        setIsStaff(staff)
        setClientChannel(data.coaching_type ?? 'vip')
        setCurrentUserId(data.id)
      } catch {}

      try {
        const token = await getToken()
        await fetch(`${API_URL}/api/community/notifications/read`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      } catch {}
    }
    init()
  }, [getToken])

  useEffect(() => {
    async function loadMembers() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/community/members`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setMembers(await res.json())
      } catch {}
      setMembersLoading(false)
    }
    loadMembers()
  }, [getToken])

  // Tabs depend on role + coaching_type
  const chatLabel = isStaff
    ? 'All Chats'
    : clientChannel === 'ai' ? 'AI/Hybrid Chat' : 'VIP Chat'

  const TABS = [
    { id: 'chat',      label: chatLabel },
    { id: 'members',   label: 'Members' },
    { id: 'mindset',   label: 'Brain Mapping/Mindset' },
    { id: 'resources', label: 'Resources' },
  ]

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Community</h1>
      <p className="text-sm text-gray-500 mb-6">Connect with your Life Warrior community</p>

      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 py-2 px-3 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              tab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'chat'      && <HybridTab getToken={getToken} isAdmin={isAdmin} isStaff={isStaff} currentUserId={currentUserId} members={members} />}
      {tab === 'members'   && <MembersTab members={members} loading={membersLoading} />}
      {tab === 'mindset'   && <ClassroomTab />}
      {tab === 'resources' && <ResourcesTab />}
    </div>
  )
}
