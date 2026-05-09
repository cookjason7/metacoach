import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'

/**
 * BarcodeScanner — renders a live camera view and calls onScan(barcodeText)
 * when a barcode is successfully decoded. Calls onCancel when the user taps Cancel.
 *
 * Cleanup: stops the camera stream on unmount OR after a successful scan so
 * no green-light stays on.
 */
export default function BarcodeScanner({ onScan, onCancel }) {
  const videoRef    = useRef(null)
  const controlsRef = useRef(null)
  const activeRef   = useRef(true)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    activeRef.current = true
    const reader = new BrowserMultiFormatReader()

    async function start() {
      try {
        const controls = await reader.decodeFromConstraints(
          {
            video: {
              facingMode: { ideal: 'environment' },
              width:  { ideal: 1280 },
              height: { ideal: 720 },
            },
          },
          videoRef.current,
          (result, _err) => {
            if (!activeRef.current || !result) return
            activeRef.current = false
            try { controls.stop() } catch {}
            onScan(result.getText())
          },
        )
        controlsRef.current = controls
        if (activeRef.current) setReady(true)
      } catch (err) {
        if (!activeRef.current) return
        const name = err?.name ?? ''
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setError(
            'Camera permission denied. Go to your browser settings, allow camera access for this site, then try again.',
          )
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          setError('No camera found on this device.')
        } else if (name === 'NotReadableError' || name === 'TrackStartError') {
          setError('Camera is in use by another app. Close other apps using the camera and try again.')
        } else {
          setError(`Camera error: ${err?.message ?? 'Could not start camera'}`)
        }
      }
    }

    start()

    return () => {
      activeRef.current = false
      try { controlsRef.current?.stop() } catch {}
    }
  }, []) // run once on mount

  /* ── Error state ── */
  if (error) {
    return (
      <div className="space-y-3">
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-4">
          <p className="text-sm font-semibold text-red-800 mb-1">Camera unavailable</p>
          <p className="text-sm text-red-600 leading-relaxed">{error}</p>
        </div>
        <button
          onClick={onCancel}
          className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"
        >
          Go Back
        </button>
      </div>
    )
  }

  /* ── Loading + video ── */
  return (
    <div className="space-y-2">
      {/* Spinner while camera initialises */}
      {!ready && (
        <div className="flex items-center justify-center py-10 gap-2">
          <span className="animate-spin inline-block w-5 h-5 border-2 border-[#E8670A] border-t-transparent rounded-full" />
          <span className="text-sm text-gray-500">Starting camera…</span>
        </div>
      )}

      {/* Video + overlay */}
      <div
        className={`relative w-full overflow-hidden rounded-xl bg-black ${ready ? '' : 'hidden'}`}
        style={{ maxHeight: '60vh' }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full block object-cover"
          style={{ maxHeight: '60vh' }}
        />

        {/* Scan-frame overlay */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {/* dark vignette */}
          <div className="absolute inset-0 bg-black/30" />
          {/* bright cut-out box */}
          <div
            className="relative z-10 bg-transparent"
            style={{ width: '82%', height: '88px' }}
          >
            {/* corner brackets */}
            <div className="absolute top-0 left-0   w-6 h-6 border-t-[3px] border-l-[3px] border-[#E8670A]" />
            <div className="absolute top-0 right-0  w-6 h-6 border-t-[3px] border-r-[3px] border-[#E8670A]" />
            <div className="absolute bottom-0 left-0  w-6 h-6 border-b-[3px] border-l-[3px] border-[#E8670A]" />
            <div className="absolute bottom-0 right-0 w-6 h-6 border-b-[3px] border-r-[3px] border-[#E8670A]" />
            {/* scan line */}
            <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[#E8670A]/70" />
          </div>
        </div>

        <p className="absolute bottom-2 inset-x-0 text-center text-[11px] text-white/60">
          Align barcode with the frame
        </p>
      </div>

      {/* Cancel button — shown once camera is live */}
      {ready && (
        <button
          onClick={onCancel}
          className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
      )}
    </div>
  )
}
