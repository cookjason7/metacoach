// Renders plain message text with any http(s):// URLs turned into clickable links.
//
// Safe by construction — no dangerouslySetInnerHTML anywhere. Every non-URL segment
// is passed through as a plain string (React escapes text children automatically),
// and the only string ever used as an href is a substring that matched
// /^https?:\/\//, so something like `javascript:alert(1)` embedded in message text
// can never become a clickable/executable link.

const URL_REGEX = /https?:\/\/[^\s<>]+/g

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

    const [url, trailing] = splitTrailingPunctuation(match[0])
    nodes.push(
      <a
        key={key++}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline break-all"
      >
        {url}
      </a>
    )
    if (trailing) nodes.push(trailing)

    lastIndex = start + match[0].length
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))

  return nodes
}
