import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'

export default function BarcodeScanner({ onScan, onCancel }) {
  const videoRef = useRef(null)
  const controlsRef = useRef(null)
  const activeRef = useRef(true)
  const startedRef = useRef(false)
  const onScanRef = useRef(onScan)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(null)
  const [retry, setRetry] = useState(0)
  const [showManualEntry, setShowManualEntry] = useState(false)
  const [manualCode, setManualCode] = useState('')

  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    activeRef.current = true
    startedRef.current = false
    controlsRef.current = null
    setReady(false)
    setError(null)

    console.log('[BarcodeScanner] starting camera, attempt', retry + 1,
      navigator?.userAgent?.slice(0, 100))

    const hints = new Map()
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.QR_CODE,
    ])
    hints.set(DecodeHintType.TRY_HARDER, true)

    const reader = new BrowserMultiFormatReader(hints, {
      delayBetweenScanAttempts: 150,
      delayBetweenScanSuccess: 500,
    })
    const startTimer = setTimeout(() => {
      if (!activeRef.current || startedRef.current) return
      activeRef.current = false
      console.error('[BarcodeScanner] camera start timeout (20 s) - no start signal received')
      try { controlsRef.current?.stop() } catch {}
      stopVideoStream()
      setError('The camera did not start. Try again, or use manual food search if your browser is blocking camera access.')
    }, 20000)

    function stopVideoStream() {
      const stream = videoRef.current?.srcObject
      if (stream?.getTracks) stream.getTracks().forEach(track => track.stop())
    }

    function setCameraError(err) {
      const name = err?.name ?? ''
      console.error('[BarcodeScanner] camera error:', name, err?.message)
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('Camera permission denied. Go to your browser settings, allow camera access for this site, then try again.')
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('No camera found on this device.')
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        setError('Camera is in use by another app. Close other apps using the camera and try again.')
      } else {
        setError(`Camera error: ${err?.message ?? 'Could not start camera'}`)
      }
    }

    async function openStreamWithFallbacks() {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        })
      } catch (err) {
        if (err?.name !== 'OverconstrainedError' && err?.name !== 'ConstraintNotSatisfiedError') throw err
        console.warn('[BarcodeScanner] resolution constraints rejected, dropping to environment-only fallback:', err?.name)
        try {
          return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        } catch {
          console.warn('[BarcodeScanner] environment facingMode failed, falling back to { video: true }')
          return navigator.mediaDevices.getUserMedia({ video: true })
        }
      }
    }

    async function waitForStableDimensions(video) {
      let stableCount = 0
      let lastW = 0
      let lastH = 0
      for (let i = 0; i < 40; i++) {
        if (!activeRef.current) return false
        const w = video?.videoWidth ?? 0
        const h = video?.videoHeight ?? 0
        if (w > 0 && h > 0 && w === lastW && h === lastH) {
          stableCount++
          console.log('[BarcodeScanner] stable dim check', stableCount, w, h)
          if (stableCount >= 3) return true
        } else {
          if (w !== lastW || h !== lastH) {
            console.log('[BarcodeScanner] dim changed', lastW, lastH, '->', w, h)
          }
          stableCount = 0
          lastW = w
          lastH = h
        }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      console.warn('[BarcodeScanner] dimensions never stabilized — proceeding anyway')
      return video?.videoWidth > 0 && video?.videoHeight > 0
    }

    async function waitForVideoDimensions(video) {
      for (let i = 0; i < 80; i++) {
        if (!activeRef.current) return false
        const videoWidth = video?.videoWidth ?? 0
        const videoHeight = video?.videoHeight ?? 0
        if (i === 0 || i % 10 === 0) {
          console.log('[BarcodeScanner] waiting for video dimensions', {
            readyState: video?.readyState,
            videoWidth,
            videoHeight,
          })
        }
        if (videoWidth > 0 && videoHeight > 0) return true
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return false
    }

    async function start() {
      let decodeAttempts = 0
      const callback = (result, err, scanControls) => {
        if (!activeRef.current) return
        const v = videoRef.current
        if (!result) {
          decodeAttempts++
          if (decodeAttempts % 30 === 0) {
            console.warn('[BarcodeScanner] decode miss/failure', {
              frame: decodeAttempts,
              error: err?.name,
              message: err?.message,
              readyState: v?.readyState,
              videoWidth: v?.videoWidth,
              videoHeight: v?.videoHeight,
            })
          }
          return
        }
        console.log('[BarcodeScanner] decoded, firing barcode lookup:', result.getText(), result.getBarcodeFormat())
        activeRef.current = false
        try { (scanControls ?? controlsRef.current)?.stop() } catch {}
        stopVideoStream()
        onScanRef.current(result.getText())
      }

      try {
        const video = videoRef.current
        if (!video) throw new Error('Scanner video element is not ready')
        const stream = await openStreamWithFallbacks()
        video.srcObject = stream
        await video.play().catch(() => {})

        // Try to lock autofocus to continuous mode (helps Samsung/Android)
        try {
          const [track] = stream.getVideoTracks()
          if (track && typeof track.applyConstraints === 'function') {
            await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
            console.log('[BarcodeScanner] continuous focus applied')
          }
        } catch (focusErr) {
          console.log('[BarcodeScanner] continuous focus not supported, skipping:', focusErr?.name)
        }

        // Wait for dimensions to appear, then stabilize (Samsung can renegotiate resolution)
        const hasDimensions = await waitForVideoDimensions(video)
        if (!hasDimensions) {
          stopVideoStream()
          throw new Error('Camera video did not become ready for scanning')
        }
        await waitForStableDimensions(video)

        if (!activeRef.current) {
          stopVideoStream()
          return
        }

        console.log('[BarcodeScanner] decode start', {
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        })
        const controls = await reader.decodeFromVideoElement(video, callback)
        controlsRef.current = controls
        startedRef.current = true
        clearTimeout(startTimer)
        console.log('[BarcodeScanner] decode loop started', {
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        })
        if (activeRef.current) setReady(true)
      } catch (err) {
        clearTimeout(startTimer)
        if (!activeRef.current) return
        stopVideoStream()
        setCameraError(err)
      }
    }

    start()

    return () => {
      activeRef.current = false
      clearTimeout(startTimer)
      try { controlsRef.current?.stop() } catch {}
      stopVideoStream()
    }
  }, [retry])

  function handleManualSubmit(e) {
    e.preventDefault()
    const code = manualCode.trim()
    if (!code) return
    onScanRef.current(code)
  }

  function retryCamera() {
    try { controlsRef.current?.stop() } catch {}
    const stream = videoRef.current?.srcObject
    if (stream?.getTracks) stream.getTracks().forEach(track => track.stop())
    controlsRef.current = null
    setError(null)
    setRetry(r => r + 1)
  }

  if (error) {
    return (
      <div className="space-y-3">
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-4">
          <p className="text-sm font-semibold text-red-800 mb-1">Camera unavailable</p>
          <p className="text-sm text-red-600 leading-relaxed">{error}</p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            onClick={retryCamera}
            className="w-full py-2.5 rounded-xl text-sm font-semibold text-white bg-[#E8670A] hover:bg-[#c45e09] transition-colors"
          >
            Try Camera Again
          </button>
          <button
            onClick={onCancel}
            className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"
          >
            Go Back
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div
        className="relative w-full overflow-hidden rounded-xl bg-black min-h-[260px]"
        style={{ maxHeight: '60vh' }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onCanPlay={() => {
            if (!activeRef.current) return
            const v = videoRef.current
            console.log('[BarcodeScanner] onCanPlay', {
              readyState: v?.readyState,
              videoWidth: v?.videoWidth,
              videoHeight: v?.videoHeight,
            })
          }}
          className="w-full min-h-[260px] block object-cover"
          style={{ maxHeight: '60vh' }}
        />

        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black">
            <span className="animate-spin inline-block w-5 h-5 border-2 border-[#E8670A] border-t-transparent rounded-full" />
            <span className="text-sm text-white/80">Starting camera...</span>
          </div>
        )}

        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative z-10 bg-transparent" style={{ width: '82%', height: '88px' }}>
            <div className="absolute top-0 left-0 w-6 h-6 border-t-[3px] border-l-[3px] border-[#E8670A]" />
            <div className="absolute top-0 right-0 w-6 h-6 border-t-[3px] border-r-[3px] border-[#E8670A]" />
            <div className="absolute bottom-0 left-0 w-6 h-6 border-b-[3px] border-l-[3px] border-[#E8670A]" />
            <div className="absolute bottom-0 right-0 w-6 h-6 border-b-[3px] border-r-[3px] border-[#E8670A]" />
            <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[#E8670A]/70" />
          </div>
        </div>

        <p className="absolute bottom-2 inset-x-0 text-center text-[11px] text-white/60">
          Align barcode with the frame
        </p>
      </div>

      <button
        onClick={onCancel}
        className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"
      >
        Cancel
      </button>

      {showManualEntry ? (
        <form onSubmit={handleManualSubmit} className="flex gap-2">
          <input
            type="text"
            inputMode="numeric"
            value={manualCode}
            onChange={e => setManualCode(e.target.value)}
            placeholder="Enter barcode number..."
            className="flex-1 border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            autoFocus
          />
          <button
            type="submit"
            disabled={!manualCode.trim()}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] disabled:opacity-40 transition-colors shrink-0"
          >
            Search
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowManualEntry(true)}
          className="w-full text-center text-xs text-gray-400 hover:text-gray-600 transition-colors py-1"
        >
          Can't scan? Enter barcode manually
        </button>
      )}
    </div>
  )
}
