import { useState } from 'react'

// Small exercise-library thumbnail. Renders nothing (not a broken-image icon)
// when there's no image_url (custom, non-library exercise) or the image fails to load.
export default function ExerciseThumb({ src, alt, className = '' }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return null

  return (
    <img
      src={src}
      alt={alt || ''}
      onError={() => setFailed(true)}
      className={`w-[50px] h-[50px] object-cover rounded-lg border border-gray-100 shrink-0 ${className}`}
    />
  )
}
