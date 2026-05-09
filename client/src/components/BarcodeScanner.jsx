import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'

export default function BarcodeScanner({ onScan, onCancel }) {
  const videoRef = useRef(null)
  const controlsRef = useRef(null)
  const activeRef = useRef(true)
  const startedRef = useRef(false)
  const onScanRef = useRef(onScan)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    activeRef.current = true
    startedRef.current = false
    controlsRef.current = null
    setReady(false)
    setError(null)

    const reader = new BrowserMultiFormatReader()
    const startTimer = setTimeout(() => {
      if (!activeRef.current || startedRef.current) return
      activeRef.current = false
      try { controlsRef.current?.stop() } catch {}
      setError('The camera did not start. Try again, or use manual food search if your browser is blocking camera access.')
    }, 10000)

    function setCameraError(err) {
      const name = err?.name ?? ''
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

    async function start() {
      const callback = (result, _err, scanControls) => {
        if (!activeRef.current || !result) return
        activeRef.current = false
        try { (scanControls ?? controlsRef.current)?.stop() } catch {}
        onScanRef.current(result.getText())
      }

      try {
        let controls
        try {
          controls = await reader.decodeFromConstraints(
            {
              video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
            },
            videoRef.current,
            callback,
          )
        } catch (err) {
          if (err?.name !== 'OverconstrainedError' && err?.name !== 'ConstraintNotSatisfiedError') {
            throw err
          }
          controls = await reader.decodeFromConstraints(
            { video: { facingMode: 'environment' } },
            videoRef.current,
            callback,
          )
        }

        if (!activeRef.current) {
          try { controls?.stop() } catch {}
          return
        }

        controlsRef.current = controls
        startedRef.current = true
        clearTimeout(startTimer)
        if (activeRef.current) setReady(true)
      } catch (err) {
        clearTimeout(startTimer)
        if (!activeRef.current) return
        setCameraError(err)
      }
    }

    start()

    return () => {
      activeRef.current = false
      clearTimeout(startTimer)
      try { controlsRef.current?.stop() } catch {}
    }
  }, [retry])

  function retryCamera() {
    try { controlsRef.current?.stop() } catch {}
    controlsRef.current = null
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
            startedRef.current = true
            setReady(true)
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
    </div>
  )
}
