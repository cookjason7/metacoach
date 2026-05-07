// Matches URLs, emails, and @mentions — in priority order so emails win over mentions
const COMBINED_RE = /(\bhttps?:\/\/\S+|(?:\S+\.)?lwcvip\.com(?:\/\S*)?|[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b|(?<!\w)@[A-Za-z]\w*)/g

export function linkify(text) {
  if (!text) return []
  const parts = []
  const re    = new RegExp(COMBINED_RE.source, 'gi')
  let lastIndex = 0
  let match

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const raw = match[0]

    if (raw.startsWith('@')) {
      parts.push(
        <span key={`m${match.index}`} className="text-[#E8670A] font-medium">
          {raw}
        </span>
      )
    } else {
      const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)
      const href    = isEmail ? `mailto:${raw}` : (raw.startsWith('http') ? raw : `https://${raw}`)
      parts.push(
        <a
          key={`l${match.index}`}
          href={href}
          target={isEmail ? undefined : '_blank'}
          rel="noopener noreferrer"
          className="underline text-blue-300 hover:text-blue-100 transition-colors"
          onClick={e => e.stopPropagation()}
        >
          {raw}
        </a>
      )
    }
    lastIndex = match.index + raw.length
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex))

  return parts
}
