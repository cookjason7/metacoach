// Renders plain message text with URLs turned into clickable links. Detects:
//   - http:// and https:// URLs
//   - www.-prefixed domains (e.g. www.lwcvip.com)
//   - bare domains with a common TLD (e.g. lwcvip.com, google.com) — restricted to
//     a known TLD whitelist so things like "Version 2.0" or "St. Louis" don't
//     get mistaken for a domain
//
// Safe by construction — no dangerouslySetInnerHTML anywhere. Every non-URL segment
// is passed through as a plain string (React escapes text children automatically).
// The only strings ever used as an href are either a substring that already matched
// /^https?:\/\//, or that same kind of substring with a hardcoded "https://" prefix
// added — so something like `javascript:alert(1)` embedded in message text can
// never become a clickable/executable link.

const KNOWN_TLDS = 'com|net|org|io|co|dev|app|ai|edu|gov|mil|info|biz|me|tv|us|uk|ca'

// The `(?<![\w@])` guards require a real token boundary before the match — this
// keeps an email address's domain (e.g. "example.com" in test@example.com) from
// being mistaken for a standalone link, without that lookbehind failure causing a
// truncated match at the next character (e.g. "xample.com").
const URL_REGEX = new RegExp(
  String.raw`https?://[^\s<>]+` +
  String.raw`|(?<![\w@])www\.[^\s<>]+` +
  String.raw`|(?<![\w@])[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.(?:${KNOWN_TLDS})\b(?:/[^\s<>]*)?`,
  'gi',
)

// Trailing punctuation (periods, commas, closing brackets, quotes) is usually part
// of the surrounding sentence, not the URL — split it off so "...see https://x.com."
// doesn't turn the sentence-ending period into part of the link.
function splitTrailingPunctuation(url) {
  const match = url.match(/^(.*?)([.,!?;:'")\]]+)$/)
  return match ? [match[1], match[2]] : [url, '']
}

export default function LinkifiedText({ text }) {
  if (!text) return text

  const nodes = []
  let lastIndex = 0
  let key = 0

  for (const match of text.matchAll(URL_REGEX)) {
    const start = match.index
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start))

    // `displayUrl` is exactly what the user typed — only `href` gets a protocol added.
    const [displayUrl, trailing] = splitTrailingPunctuation(match[0])
    const href = /^https?:\/\//i.test(displayUrl) ? displayUrl : `https://${displayUrl}`
    nodes.push(
      <a
        key={key++}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline break-all"
      >
        {displayUrl}
      </a>
    )
    if (trailing) nodes.push(trailing)

    lastIndex = start + match[0].length
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))

  return nodes
}
