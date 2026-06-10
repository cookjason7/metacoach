import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useSearchParams, useNavigate } from 'react-router-dom'
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
    <div className="relative w-full">
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
    like_count: 0, love_count: 0, laugh_count: 0, care_count: 0,
    my_like: false, my_love: false, my_laugh: false, my_care: false,
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

      <div className="p-4">
        {/* Header */}
        <div className="flex items-start gap-3 mb-3">
          <Avatar name={post.first_name} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-gray-900">{post.first_name ?? 'Member'}</p>
              {post.hot && <span title="Trending" className="text-sm leading-none">🔥</span>}
            </div>
            <p className="text-xs text-gray-400">{timeAgo(post.created_at)}</p>
          </div>
          {catStyle && !isEditing && (
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium shrink-0 max-w-[9rem] truncate ${catStyle}`}>
              {post.category}
            </span>
          )}
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
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
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
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
            <form onSubmit={submitComment} className="flex gap-2 mt-3 items-end">
              <MentionInput
                value={commentText}
                onChange={setCommentText}
                members={members}
                placeholder="Add a comment…"
                rows={1}
                inputClassName="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
              <button
                type="submit"
                disabled={!commentText.trim() || submitting}
                className="bg-[#E8670A] text-white px-3 py-2 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-40 transition-colors shrink-0"
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

function HybridTab({ getToken, isAdmin, isStaff, channel, currentUserId, members, initialCategory = 'All' }) {
  const photoInputRef = useRef(null)
  const [posts,          setPosts]         = useState([])
  const [hasMore,        setHasMore]       = useState(false)
  const [nextBeforeId,   setNextBeforeId]  = useState(null)
  const [loadingOlder,   setLoadingOlder]  = useState(false)
  const [loading,        setLoading]       = useState(true)
  const [error,          setError]         = useState(null)
  const [retryKey,       setRetryKey]      = useState(0)
  const [newPost,        setNewPost]       = useState('')
  const [category,       setCategory]      = useState(initialCategory === 'All' ? 'General Discussion' : initialCategory)
  const [poll,           setPoll]          = useState(null)
  const [photo,          setPhoto]         = useState(null)
  const [preview,        setPreview]       = useState(null)
  const [posting,        setPosting]       = useState(false)
  const [search,         setSearch]        = useState('')
  const [activeCategory, setActiveCategory]= useState(initialCategory)

  useEffect(() => {
    setLoading(true)
    setError(null)
    async function load() {
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/community/posts?channel=${channel}&limit=30`, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        const data = await res.json()
        setPosts(data.posts ?? [])
        setHasMore(data.hasMore ?? false)
        setNextBeforeId(data.nextBeforeId ?? null)
      } catch (err) { setError(err.message) }
      finally { setLoading(false) }
    }
    load()
  }, [getToken, channel, retryKey])

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
      body.append('channel', channel)
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
      setNewPost(''); setCategory('General Discussion'); setPoll(null); clearPhoto()
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

  const loadOlderPosts = useCallback(async () => {
    if (!nextBeforeId || loadingOlder) return
    setLoadingOlder(true)
    try {
      const token = await getToken()
      const res = await fetch(
        `${API_URL}/api/community/posts?channel=${channel}&limit=30&before_id=${nextBeforeId}`,
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
  }, [channel, nextBeforeId, loadingOlder, getToken])

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

        {/* Feed filter */}
        <div className="flex items-center gap-2 mb-4">
          <select
            value={activeCategory}
            onChange={e => setActiveCategory(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
          >
            <option value="All">All Posts</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* Compose */}
        <form onSubmit={submitPost} className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5 mb-5">
          <MentionInput
            value={newPost}
            onChange={setNewPost}
            members={members}
            placeholder="Share a win, ask a question, or check in with the group…"
            rows={3}
            textareaClassName="w-full border border-gray-200 rounded-lg px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#E8670A] min-h-[96px]"
          />

          {/* Category dropdown */}
          <div className="flex items-center gap-3 mt-3">
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white flex-1"
            >
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
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

          <div className="flex items-center justify-between gap-3 mt-3">
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
              className="bg-[#E8670A] text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0 min-w-[88px]"
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
              className="inline-flex items-center gap-1.5 bg-[#E8670A] text-white text-xs font-bold px-4 py-2.5 rounded-xl hover:bg-[#c45e09] transition-colors"
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

        <div className="space-y-3">
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
        {hasMore && (
          <div className="text-center mt-4">
            <button
              onClick={loadOlderPosts}
              disabled={loadingOlder}
              className="text-sm text-gray-500 hover:text-[#E8670A] disabled:opacity-40 underline"
            >
              {loadingOlder ? 'Loading…' : 'Load more posts'}
            </button>
          </div>
        )}
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

const EMPTY_VIDEO = { title: '', description: '', youtube_url: '', module_name: '', display_order: 0, published: false }

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
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A]"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">YouTube URL *</label>
            <input
              value={form.youtube_url}
              onChange={e => set('youtube_url', e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A]"
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
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A] resize-none"
            />
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label className="block text-xs font-semibold text-gray-700 mb-1">Module / Category</label>
              <input
                value={form.module_name}
                onChange={e => set('module_name', e.target.value)}
                placeholder="e.g. Brain Mapping"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A]"
              />
            </div>
            <div className="w-full sm:w-24">
              <label className="block text-xs font-semibold text-gray-700 mb-1">Order</label>
              <input
                type="number"
                value={form.display_order}
                onChange={e => set('display_order', Number(e.target.value))}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A]"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.published}
              onChange={e => set('published', e.target.checked)}
              className="w-4 h-4 accent-[#E8670A]"
            />
            <span className="text-sm font-medium text-gray-700">Published (visible to clients)</span>
          </label>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium">Cancel</button>
          <button
            onClick={() => onSave(form)}
            disabled={saving || !form.title.trim() || !form.youtube_url.trim() || (form.youtube_url && !ytVideoId(form.youtube_url))}
            className="px-5 py-2 bg-[#E8670A] text-white text-sm font-bold rounded-xl hover:bg-[#c45e09] disabled:opacity-50 transition-colors"
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
    console.log('[MindsetVideo] reportPct fired — videoId:', videoId, 'pct:', pct)
    const gt = getTokenRef.current
    if (!gt) {
      console.warn('[MindsetVideo] progress skipped: no auth token getter')
      return
    }
    try {
      const token = await gt()
      if (!token) {
        console.warn('[MindsetVideo] progress skipped: missing auth token')
        return
      }
      const url = `${API_URL}/api/mindset-videos/${videoId}/progress`
      console.log('[MindsetVideo] POST', url, { pct })
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pct }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}))
        console.warn('[MindsetVideo] progress save failed:', res.status, detail.error ?? res.statusText)
        return
      }
      const data = await res.json().catch(() => ({}))
      console.log('[MindsetVideo] progress saved OK:', data)
      if (onProgressSavedRef.current) {
        onProgressSavedRef.current(videoId, data.highest_pct ?? pct, Boolean(data.completed))
      }
    } catch (err) {
      console.warn('[MindsetVideo] progress save error:', err)
    }
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
          onError: (e) => {
            console.warn('[YoutubePlayer] player error code:', e.data)
          },
        },
      })
    }).catch(err => {
      if (!cancelled) {
        console.warn('[YoutubePlayer] API failed to load:', err.message)
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

function VideoCard({ video, isStaff, onEdit, onDelete, onTogglePublish, expanded, onToggleExpand, getToken, progress, onProgressSaved }) {
  const vid = ytVideoId(video.youtube_url)
  const [ytFailed, setYtFailed] = useState(false)

  // Reset fallback when video collapses so next expansion tries the API again
  useEffect(() => { if (!expanded) setYtFailed(false) }, [expanded])

  const statusLabel = !isStaff
    ? progress?.completed
      ? { text: '✓ Completed', cls: 'bg-emerald-100 text-emerald-700' }
      : progress?.started
        ? { text: `In progress · ${Math.round(progress.highest_pct ?? 0)}%`, cls: 'bg-[#fde8c8] text-[#c45e09]' }
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
                <div className="w-14 h-14 bg-[#E8670A] rounded-full flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
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
              {video.module_name && (
                <span className="text-xs font-semibold bg-[#fde8c8] text-[#c45e09] px-2 py-0.5 rounded-full">
                  {video.module_name}
                </span>
              )}
              {isStaff && (
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  video.published ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                }`}>
                  {video.published ? 'Published' : 'Draft'}
                </span>
              )}
              {statusLabel && (
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${statusLabel.cls}`}>
                  {statusLabel.text}
                </span>
              )}
            </div>
            <h3 className="text-sm font-bold text-gray-900 leading-snug">{video.title}</h3>
            {video.description && (
              <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{video.description}</p>
            )}
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
                className="p-2 rounded-lg text-gray-400 hover:text-[#E8670A] hover:bg-[#fde8c8] transition-colors"
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
              className="inline-flex items-center gap-1.5 bg-[#E8670A] text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-[#c45e09] transition-colors min-h-[36px]"
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
      </div>
    </div>
  )
}

// ── FeaturedVideoCard (Continue Watching / Start Here) ───────────────────────

function FeaturedVideoCard({ video, progress, label, onWatch }) {
  const vid = ytVideoId(video.youtube_url)
  const pct = Math.min(Math.round(progress?.highest_pct ?? 0), 100)

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden mb-5" style={{ borderTop: '3px solid #E8670A' }}>
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
              <div className="w-9 h-9 bg-[#E8670A] rounded-full flex items-center justify-center shadow-md group-hover:scale-110 transition-transform">
                <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </div>
          </button>
        )}

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-widest mb-0.5">{label}</p>
          {video.module_name && (
            <p className="text-[11px] text-gray-400 mb-0.5">{video.module_name}</p>
          )}
          <p className="text-sm font-bold text-gray-900 leading-snug line-clamp-2">{video.title}</p>

          {pct > 0 && (
            <div className="mt-2 mb-1">
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-[#E8670A] rounded-full" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">{pct}% watched</p>
            </div>
          )}

          <button
            onClick={onWatch}
            className="mt-2 inline-flex items-center gap-1.5 bg-[#E8670A] text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-[#c45e09] transition-colors min-h-[36px]"
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

function MindsetTab({ getToken, isStaff }) {
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
      const vids = await res.json()
      setVideos(vids)
      if (progressRes) {
        if (progressRes.ok) {
          setMyProgress(await progressRes.json())
        } else {
          console.warn('[MindsetVideo] progress fetch failed:', progressRes.status, progressRes.statusText)
        }
      }
    } catch (e) {
      setError(e.message)
    }
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
    } catch (e) {
      console.warn('[MindsetVideo] progress refresh failed:', e)
    }
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

  // Published videos sorted by display_order (client view)
  const publishedVideos = videos
    .filter(v => v.published)
    .sort((a, b) => (a.display_order ?? 999) - (b.display_order ?? 999))

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

  // Group published videos by module_name, order preserved from sort above
  const grouped = publishedVideos.reduce((acc, v) => {
    const key = v.module_name || 'General'
    if (!acc[key]) acc[key] = []
    acc[key].push(v)
    return acc
  }, {})

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
              className="inline-flex items-center justify-center gap-2 bg-[#E8670A] text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-[#c45e09] transition-colors"
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
                    <span className="text-sm font-bold text-[#E8670A]">{progressPct}%</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#E8670A] rounded-full transition-all duration-500"
                      style={{ width: `${progressPct}%` }}
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

              {/* Grouped video list */}
              <div className="space-y-8">
                {Object.entries(grouped).map(([module, mvids]) => (
                  <div key={module}>
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">{module}</h3>
                    <div className="space-y-4">
                      {mvids.map(v => (
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
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
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
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A]" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Type</label>
            <div className="flex gap-2">
              {RESOURCE_TYPES.map(t => (
                <button key={t.id} type="button"
                  onClick={() => { set('resource_type', t.id); setFile(null) }}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold border-2 transition-colors ${
                    form.resource_type === t.id
                      ? 'bg-[#E8670A] border-[#E8670A] text-white'
                      : 'border-gray-200 text-gray-600 hover:border-[#E8670A]'
                  }`}>
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
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A]" />
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
                    className="text-xs text-[#E8670A] font-semibold hover:text-[#c45e09]">Replace</button>
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
                  className="w-full border-2 border-dashed border-gray-300 rounded-xl py-5 text-sm text-gray-400 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors">
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
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A] resize-none" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-semibold text-gray-700 mb-1">Category</label>
              <input value={form.category} onChange={e => set('category', e.target.value)} placeholder="e.g. Nutrition"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A]" />
            </div>
            <div className="w-24">
              <label className="block text-xs font-semibold text-gray-700 mb-1">Order</label>
              <input type="number" value={form.display_order} onChange={e => set('display_order', Number(e.target.value))}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A]" />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={form.published} onChange={e => set('published', e.target.checked)}
              className="w-4 h-4 accent-[#E8670A]" />
            <span className="text-sm font-medium text-gray-700">Published (visible to clients)</span>
          </label>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium">Cancel</button>
          <button onClick={() => onSave(form, file)} disabled={!canSave}
            className="px-5 py-2 bg-[#E8670A] text-white text-sm font-bold rounded-xl hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Resource'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ResourceCard({ resource, isStaff, onEdit, onDelete, onTogglePublish }) {
  const t = rtype(resource.resource_type)
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4">
      <div className="flex items-start gap-3">
        <div className="text-2xl leading-none shrink-0 mt-0.5">{t.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${t.badge}`}>{t.label}</span>
            {resource.category && (
              <span className="text-xs font-semibold bg-[#fde8c8] text-[#c45e09] px-2 py-0.5 rounded-full">{resource.category}</span>
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
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#E8670A] hover:text-[#c45e09] transition-colors">
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
                <button onClick={() => onEdit(resource)} className="text-xs font-semibold text-gray-400 hover:text-[#E8670A] transition-colors">Edit</button>
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
      const items = await res.json()
      setResources(items)
    } catch (e) {
      setError(e.message)
    }
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
            className="inline-flex items-center justify-center gap-2 bg-[#E8670A] text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-[#c45e09] transition-colors">
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
            {resources.map(r => (
              <ResourceCard key={r.id} resource={r} isStaff
                onEdit={setModal} onDelete={setDeleteTarget} onTogglePublish={handleTogglePublish} />
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
// Friendly URL aliases → canonical tab IDs
const TAB_ALIASES = { 'brain-mapping': 'mindset' }

function resolveUrlTab(raw) {
  if (!raw) return null
  const canonical = TAB_ALIASES[raw] ?? raw
  return VALID_URL_TABS.includes(canonical) ? canonical : null
}

export default function Community() {
  const { getToken }                       = useAuth()
  const [searchParams]                     = useSearchParams()
  const navigate                           = useNavigate()
  const [isAdmin,        setIsAdmin]       = useState(false)
  const [isStaff,        setIsStaff]       = useState(false)
  const [clientChannel,  setClientChannel] = useState('vip')
  const [currentUserId,  setCurrentUserId] = useState(null)
  const [members,        setMembers]       = useState([])
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
      const staff = data.role === 'admin' || data.role === 'coach' || data.role === 'staff'
      // Basic clients have no community access — redirect to dashboard
      if (!staff && data.coaching_type === 'basic') {
        navigate('/dashboard', { replace: true })
        return
      }
      const ch    = normalizeChannel(data.coaching_type)
      setIsAdmin(data.role === 'admin')
      setIsStaff(staff)
      setClientChannel(ch)
      setCurrentUserId(data.id)
      // Respect ?tab= URL param (e.g. Brain Mapping sidebar link → ?tab=mindset)
      // Read window.location.search directly to avoid adding searchParams as a
      // callback dependency (which would cause unnecessary re-fetches).
      const rawUrlTab = new URLSearchParams(window.location.search).get('tab')
      const defaultTab = staff ? 'vip' : ch
      const resolvedTab = resolveUrlTab(rawUrlTab) ?? defaultTab
      setTab(resolvedTab)
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
    } catch {}
  }, [getToken])

  // Handle sidebar navigation to ?tab=mindset (or any valid tab) while
  // Community is already mounted — React Router won't remount the component,
  // it only updates searchParams.
  useEffect(() => {
    if (initLoading || tab === null) return // wait for init
    const resolved = resolveUrlTab(searchParams.get('tab'))
    const defaultTab = isStaff ? 'vip' : clientChannel
    const nextTab = resolved ?? defaultTab
    if (tab !== nextTab) {
      setTab(nextTab)
    }
  }, [searchParams, initLoading, isStaff, clientChannel, tab])

  const handleTabSelect = useCallback((nextTab) => {
    const defaultTab = isStaff ? 'vip' : clientChannel
    setTab(nextTab)
    navigate({
      pathname: '/community',
      search: nextTab === defaultTab ? '' : `?tab=${nextTab}`,
    })
  }, [clientChannel, isStaff, navigate])

  useEffect(() => {
    runInit()
  }, [runInit])

  useEffect(() => {
    async function loadMembers() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/community/members`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setMembers(await res.json())
      } catch {}
    }
    loadMembers()
  }, [getToken])

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
        <p className="text-sm text-gray-500 mb-6">Connect with your Life Warrior community</p>
        <div className="flex justify-center py-16">
          <span className="text-sm text-gray-400">Loading…</span>
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
      <p className="text-sm text-gray-500 mb-6">Connect with your Life Warrior community</p>

      {clientOnHiddenTab ? (
        // Minimal nav when showing Brain Mapping or Resources via sidebar link —
        // just a back-to-chat button so the user isn't stranded
        <div className="mb-6">
          <button
            onClick={() => handleTabSelect(clientChannel)}
            className="flex items-center gap-1.5 text-sm font-medium text-[#E8670A] hover:text-[#c45e09] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back to Group Chat
          </button>
        </div>
      ) : (
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6 overflow-x-auto">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => handleTabSelect(t.id)}
              className={`flex-1 shrink-0 py-2 px-1.5 sm:px-2 rounded-lg text-xs sm:text-sm font-medium transition-colors text-center whitespace-nowrap ${
                tab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Group Chat — VIP or AI channel feed */}
      {(tab === 'vip' || tab === 'ai') && (
        <HybridTab
          key={tab}
          channel={tab}
          getToken={getToken}
          isAdmin={isAdmin}
          isStaff={isStaff}
          currentUserId={currentUserId}
          members={members}
        />
      )}

      {/* Brain Mapping — accessible via sidebar ?tab=mindset link for all users */}
      {tab === 'mindset'   && <MindsetTab getToken={getToken} isStaff={isStaff} />}

      {/* Resources — staff tab + URL-accessible for direct links */}
      {tab === 'resources' && <ResourcesTab getToken={getToken} isStaff={isStaff} />}
    </div>
  )
}
