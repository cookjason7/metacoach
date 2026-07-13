import { useState, useRef, useCallback } from 'react'

export function useVoiceRecorder() {
  const [recording,    setRecording]    = useState(false)
  const [audioBlob,    setAudioBlob]    = useState(null)
  const [audioPreview, setAudioPreview] = useState(null)
  const [recordError,  setRecordError]  = useState(null) // 'not_supported' | 'permission_denied' | 'unknown'
  const mrRef     = useRef(null)
  const chunksRef = useRef([])
  const streamRef = useRef(null)

  const canRecord =
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    !!(navigator.mediaDevices?.getUserMedia)

  const startRecording = useCallback(async () => {
    setRecordError(null)
    if (!canRecord) { setRecordError('not_supported'); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      // Android System WebView supports audio/mp4 more reliably than webm, so try it first.
      const mimeType =
        MediaRecorder.isTypeSupported('audio/mp4')              ? 'audio/mp4' :
        MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
        MediaRecorder.isTypeSupported('audio/webm')             ? 'audio/webm' : ''
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {})
      chunksRef.current = []
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
        setAudioBlob(blob)
        setAudioPreview(URL.createObjectURL(blob))
        stream.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
      mr.start(250)
      mrRef.current = mr
      setRecording(true)
    } catch (err) {
      setRecordError(err.name === 'NotAllowedError' ? 'permission_denied' : 'unknown')
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
    }
  }, [canRecord])

  const stopRecording = useCallback(() => {
    mrRef.current?.stop()
    setRecording(false)
  }, [])

  const clearAudio = useCallback(() => {
    if (audioPreview) URL.revokeObjectURL(audioPreview)
    setAudioBlob(null)
    setAudioPreview(null)
  }, [audioPreview])

  return { canRecord, recording, audioBlob, audioPreview, recordError, startRecording, stopRecording, clearAudio }
}
