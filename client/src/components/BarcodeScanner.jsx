import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'

export default function BarcodeScanner({ onScan, onCancel }) {
  const videoRef = useRef(null)
  const controlsRef = useRef(null)
  const activeRef = useRef(true)
  const startedRef = useRef(false)
  const startDelayRef = useRef(null)
  const focusTimerRef = useRef(null)
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
    if (startDelayRef.current) clearTimeout(startDelayRef.current)
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current)
    setReady(false)
    setError(null)

    const nativeAvailable = typeof BarcodeDetector !== 'undefined'
    console.log('[BarcodeScanner] starting camera, attempt', retry + 1,
      '| engine:', nativeAvailable ? 'native BarcodeDetector' : 'zxing-js',
      '| ua:', navigator?.userAgent?.slice(0, 80))

    // ZXing reader — only used on non-native path (iOS Safari, Firefox, etc.)
    const hints = new Map()
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
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
      console.error('[BarcodeScanner] camera start timeout (20 s) — no start signal received')
      try { controlsRef.current?.stop() } catch {}
      stopVideoStream()
      setError('The camera did not start. Try again, or use manual food search if your browser is blocking camera access.')
    }, 20000)

    function stopVideoStream() {
      const stream = videoRef.current?.srcObject
      if (stream?.getTracks) stream.getTracks().forEach(track => track.stop())
      if (videoRef.current) videoRef.current.srcObject = null
    }

    function scheduleContinuousFocus(stream) {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current)
      focusTimerRef.current = setTimeout(async () => {
        if (!activeRef.current) return
        try {
          const [track] = stream.getVideoTracks()
          if (track && typeof track.applyConstraints === 'function') {
            await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
            console.log('[BarcodeScanner] continuous focus applied')
          }
        } catch (focusErr) {
          console.log('[BarcodeScanner] continuous focus not supported:', focusErr?.name)
        }
      }, 700)
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

    // Wait for the video element to report non-zero dimensions
    async function waitForVideoDimensions(video) {
      for (let i = 0; i < 80; i++) {
        if (!activeRef.current) return false
        if ((video?.videoWidth ?? 0) > 0 && (video?.videoHeight ?? 0) > 0) return true
        if (i === 0 || i % 20 === 0) {
          console.log('[BarcodeScanner] waiting for video dims', {
            readyState: video?.readyState,
            videoWidth: video?.videoWidth,
            videoHeight: video?.videoHeight,
          })
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return false
    }

    // Wait for dimensions to stop changing (Samsung can renegotiate resolution)
    async function waitForStableDimensions(video) {
      let stableCount = 0; let lastW = 0; let lastH = 0
      for (let i = 0; i < 40; i++) {
        if (!activeRef.current) return false
        const w = video?.videoWidth ?? 0; const h = video?.videoHeight ?? 0
        if (w > 0 && h > 0 && w === lastW && h === lastH) {
          if (++stableCount >= 3) return true
        } else { stableCount = 0; lastW = w; lastH = h }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      console.warn('[BarcodeScanner] dimensions never stabilized — proceeding anyway')
      return (video?.videoWidth ?? 0) > 0 && (video?.videoHeight ?? 0) > 0
    }

    async function start() {
      let decodeAttempts = 0
      try {
        const video = videoRef.current
        if (!video) throw new Error('Scanner video element is not ready')

        const stream = await openStreamWithFallbacks()
        video.srcObject = stream
        await video.play().catch(() => {})

        const hasDimensions = await waitForVideoDimensions(video)
        if (!hasDimensions) {
          stopVideoStream()
          throw new Error('Camera video did not become ready for scanning')
        }
        await waitForStableDimensions(video)
        if (!activeRef.current) { stopVideoStream(); return }

        console.log('[BarcodeScanner] decode start', {
          engine: nativeAvailable ? 'native' : 'zxing',
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        })

        // ── Primary: native BarcodeDetector (Android Chrome 83+, Samsung Internet 14+) ──
        // Delegates to the device's hardware-accelerated barcode engine (backed by
        // Google ML Kit on Android). Far more reliable than ZXing JS on Android.
        if (nativeAvailable) {
          try {
            // Filter to formats the device actually supports
            let formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code']
            try {
              const supported = await BarcodeDetector.getSupportedFormats()
              const filtered = formats.filter(f => supported.includes(f))
              if (filtered.length > 0) formats = filtered
            } catch { /* keep defaults if getSupportedFormats unavailable */ }
            console.log('[BarcodeScanner] native BarcodeDetector formats:', formats)

            const detector = new BarcodeDetector({ formats })
            let rafId

            // rAF loop — ~60fps, native detection does not block the main thread
            const rafLoop = async () => {
              if (!activeRef.current) return
              try {
                const barcodes = await detector.detect(video)
                if (!activeRef.current) return        // guard against unmount during async detect
                if (barcodes.length > 0) {
                  const code = barcodes[0].rawValue
                  console.log('[BarcodeScanner] native decoded:', code, barcodes[0].format)
                  activeRef.current = false
                  cancelAnimationFrame(rafId)
                  stopVideoStream()
                  onScanRef.current(code)
                  return
                }
              } catch (err) {
                decodeAttempts++
                if (decodeAttempts % 60 === 0) {
                  console.warn('[BarcodeScanner] native detect miss', decodeAttempts, err?.name)
                }
              }
              if (activeRef.current) rafId = requestAnimationFrame(rafLoop)
            }

            controlsRef.current = { stop: () => cancelAnimationFrame(rafId) }
            startedRef.current = true
            clearTimeout(startTimer)
            if (activeRef.current) setReady(true)
            scheduleContinuousFocus(stream)
            rafId = requestAnimationFrame(rafLoop)
            console.log('[BarcodeScanner] native decode loop started')
            return  // success — don't fall through to ZXing
          } catch (nativeErr) {
            // BarcodeDetector existed but failed to init/run — fall through to ZXing
            console.warn('[BarcodeScanner] native BarcodeDetector setup failed, falling back to ZXing:', nativeErr?.message)
          }
        }

        // ── Fallback: ZXing JS (iOS Safari, Firefox, desktop, unsupported browsers) ──
        const callback = (result, err, scanControls) => {
          if (!activeRef.current) return
          const v = videoRef.current
          if (!result) {
            decodeAttempts++
            if (decodeAttempts % 30 === 0) {
              console.warn('[BarcodeScanner] zxing decode miss', {
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
          console.log('[BarcodeScanner] zxing decoded:', result.getText(), result.getBarcodeFormat())
          activeRef.current = false
          try { (scanControls ?? controlsRef.current)?.stop() } catch {}
          stopVideoStream()
          onScanRef.current(result.getText())
        }

        const controls = await reader.decodeFromVideoElement(video, callback)
        controlsRef.current = controls
        startedRef.current = true
        clearTimeout(startTimer)
        console.log('[BarcodeScanner] zxing decode loop started', {
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        })
        if (activeRef.current) setReady(true)
        scheduleContinuousFocus(stream)

      } catch (err) {
        clearTimeout(startTimer)
        if (!activeRef.current) return
        stopVideoStream()
        setCameraError(err)
      }
    }

    // React StrictMode runs an immediate setup/cleanup/setup cycle in dev.
    // Deferring camera startup lets the throwaway cleanup cancel before getUserMedia opens.
    startDelayRef.current = setTimeout(() => {
      startDelayRef.current = null
      if (activeRef.current) start()
    }, 120)

    return () => {
      activeRef.current = false
      if (startDelayRef.current) clearTimeout(startDelayRef.current)
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current)
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
        className="relative w-full aspect-[4/3] overflow-hidden rounded-xl bg-slate-950 min-h-[260px] max-h-[60dvh]"
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
          className={`h-full w-full min-h-[260px] block object-cover transition-opacity duration-200 ${ready ? 'opacity-100' : 'opacity-70'}`}
        />

        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-slate-950/45 transition-opacity duration-200">
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
