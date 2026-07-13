import { useState, useRef, useCallback } from 'react'
import { VoiceRecorder } from 'capacitor-voice-recorder'

// In the Capacitor Android WebView, getUserMedia() fails with NotReadableError for the
// microphone. The capacitor-voice-recorder plugin records through native Android/iOS APIs
// instead of the WebView, so on native platforms we route recording through it and keep the
// browser getUserMedia/MediaRecorder path for the web build. The hook interface is identical
// in both modes, so StaffInbox.jsx / Messages.jsx need no changes.
const isNative =
  typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true

// Native recordings come back as base64 (Android encodes with Base64.DEFAULT, which inserts
// newlines, and some platforms prepend a data: URI header). Strip both, then decode to a Blob.
function base64ToBlob(base64, type) {
  const clean = String(base64).replace(/^data:[^;]*;base64,/, '').replace(/\s/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: type || 'audio/aac' })
}

// Map a native plugin rejection to the same recordError vocabulary the web path uses.
function nativeErrorToState(err) {
  const msg = (err?.message ?? err?.code ?? err ?? '').toString()
  if (/permission/i.test(msg)) return 'permission_denied'
  return msg || 'unknown'
}

export function useVoiceRecorder() {
  const [recording,    setRecording]    = useState(false)
  const [audioBlob,    setAudioBlob]    = useState(null)
  const [audioPreview, setAudioPreview] = useState(null)
  const [recordError,  setRecordError]  = useState(null) // 'not_supported' | 'permission_denied' | error details (name: message)
  const mrRef     = useRef(null)
  const chunksRef = useRef([])
  const streamRef = useRef(null)

  // Native devices can always record via the plugin; on web we require MediaRecorder + getUserMedia.
  const canRecord =
    isNative ||
    (typeof window !== 'undefined' &&
      typeof window.MediaRecorder !== 'undefined' &&
      !!(navigator.mediaDevices?.getUserMedia))

  const startRecording = useCallback(async () => {
    setRecordError(null)

    // ── Native path: capacitor-voice-recorder ────────────────────────────────
    if (isNative) {
      try {
        const supported = await VoiceRecorder.canDeviceVoiceRecord()
        if (!supported?.value) { setRecordError('not_supported'); return }
        const has = await VoiceRecorder.hasAudioRecordingPermission().catch(() => ({ value: false }))
        if (!has?.value) {
          const req = await VoiceRecorder.requestAudioRecordingPermission()
          if (!req?.value) { setRecordError('permission_denied'); return }
        }
        await VoiceRecorder.startRecording()
        setRecording(true)
      } catch (err) {
        console.error('VoiceRecorder(native) start error:', err)
        setRecordError(nativeErrorToState(err))
      }
      return
    }

    // ── Web path: getUserMedia + MediaRecorder ───────────────────────────────
    if (!canRecord) { setRecordError('not_supported'); return }
    console.log('canRecord:', canRecord, 'MediaRecorder:', typeof MediaRecorder, 'getUserMedia:', !!navigator.mediaDevices?.getUserMedia)
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
      console.error('VoiceRecorder error:', err.name, err.message, err)
      setRecordError(err.name === 'NotAllowedError' ? 'permission_denied' : (err.name || 'unknown'))
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
    }
  }, [canRecord])

  const stopRecording = useCallback(async () => {
    // ── Native path: fetch the recorded audio and build a Blob ────────────────
    if (isNative) {
      try {
        const { value } = await VoiceRecorder.stopRecording()
        setRecording(false)
        if (!value?.recordDataBase64) { setRecordError('unknown'); return }
        const blob = base64ToBlob(value.recordDataBase64, value.mimeType)
        setAudioBlob(blob)
        setAudioPreview(URL.createObjectURL(blob))
      } catch (err) {
        console.error('VoiceRecorder(native) stop error:', err)
        setRecording(false)
        setRecordError(nativeErrorToState(err))
      }
      return
    }

    // ── Web path: MediaRecorder.onstop builds the Blob ───────────────────────
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
