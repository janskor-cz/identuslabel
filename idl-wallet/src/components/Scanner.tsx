/**
 * Multipurpose QR Scanner Component
 *
 * Reusable scanner for OOB invitations, proof requests, credential offers, etc.
 * Uses @yudiel/react-qr-scanner for camera access and QR detection.
 */

import React, { useState, useEffect } from 'react';
import { Scanner as QRScanner } from '@yudiel/react-qr-scanner';
import { parseQRMessage, validateQRMessage, MessageType, ScanResult } from '@/utils/qrMessageParser';

export interface ScannerProps {
  // Extensibility: Filter by allowed message types
  allowedTypes?: MessageType[];

  // Callback for successful scan
  onScan: (result: ScanResult) => void;

  // Callback for errors
  onError?: (error: Error) => void;

  // UI customization
  className?: string;
  showOverlay?: boolean;

  // Camera preferences
  preferredCamera?: 'front' | 'back';
  enableTorch?: boolean;

  // Behavior
  scanMode?: 'single' | 'continuous';
  pauseAfterScan?: boolean;

  // Auto-dismiss
  autoClose?: boolean;
  autoCloseDelay?: number; // milliseconds
}

export const Scanner: React.FC<ScannerProps> = ({
  allowedTypes,
  onScan,
  onError,
  className = '',
  showOverlay = true,
  preferredCamera = 'back',
  enableTorch = false,
  scanMode = 'single',
  pauseAfterScan = true,
  autoClose = false,
  autoCloseDelay = 2000,
}) => {
  const [isPaused, setIsPaused] = useState(false);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Handle QR code detection
  const handleDecode = async (result: string) => {
    // Prevent duplicate scans
    if (result === lastScan && pauseAfterScan) {
      console.log('⚠️ [Scanner] Duplicate scan detected, ignoring');
      return;
    }

    console.log('📷 [Scanner] QR code detected:', result.substring(0, 50) + '...');
    setLastScan(result);
    setError(null);

    try {
      // Parse QR code content
      const parsedResult = await parseQRMessage(result);
      console.log('✅ [Scanner] Message type detected:', parsedResult.messageType);

      // Filter by allowed types if specified
      if (allowedTypes && allowedTypes.length > 0) {
        if (!allowedTypes.includes(parsedResult.messageType)) {
          throw new Error(
            `This scanner only accepts: ${allowedTypes.join(', ')}. ` +
            `Scanned message type is: ${parsedResult.messageType}`
          );
        }
      }

      // Validate message for security
      await validateQRMessage(parsedResult);

      // Pause scanner if single-scan mode
      if (scanMode === 'single') {
        setIsPaused(true);
        setScanning(false);
      }

      // Success callback
      onScan(parsedResult);

      // Auto-close if enabled
      if (autoClose && autoCloseDelay > 0) {
        console.log(`🕐 [Scanner] Auto-closing in ${autoCloseDelay}ms...`);
        setTimeout(() => {
          console.log('✅ [Scanner] Auto-closed successfully');
        }, autoCloseDelay);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown scan error');
      console.error('❌ [Scanner] Scan error:', error.message);
      setError(error.message);
      onError?.(error);

      // Reset for next scan
      setLastScan(null);
    }
  };

  // Handle scanner errors (camera access, etc.)
  const handleError = (err: unknown) => {
    const error = err instanceof Error ? err : new Error('Scanner error');
    console.error('❌ [Scanner] Camera error:', error.message);

    // Common error messages
    let userMessage = error.message;
    if (error.message.includes('Permission')) {
      userMessage = 'Camera permission denied. Please allow camera access in your browser settings.';
    } else if (error.message.includes('NotFound')) {
      userMessage = 'No camera found. Please check your device has a working camera.';
    } else if (error.message.includes('NotAllowed')) {
      userMessage = 'Camera access blocked. Please enable camera permissions for this site.';
    }

    setError(userMessage);
    onError?.(new Error(userMessage));
  };

  // Reset scanner
  const resetScanner = () => {
    setIsPaused(false);
    setScanning(true);
    setLastScan(null);
    setError(null);
    console.log('🔄 [Scanner] Reset and ready for next scan');
  };

  return (
    <div className={`scanner-container ${className}`}>
      {/* Scanner view */}
      <div className="scanner-view relative">
        {scanning && (
          <QRScanner
            onDecode={handleDecode}
            onError={handleError}
            paused={isPaused}
            constraints={{
              facingMode: preferredCamera === 'front' ? 'user' : 'environment',
              aspectRatio: 1,
            }}
            scanDelay={500} // Prevent rapid duplicate scans
            components={{
              audio: true, // Beep on successful scan
              torch: enableTorch,
            }}
            styles={{
              container: {
                width: '100%',
                height: '100%',
                position: 'relative',
              },
            }}
          />
        )}

        {/* Overlay with scanning guide */}
        {showOverlay && scanning && (
          <div className="scanner-overlay absolute inset-0 pointer-events-none flex items-center justify-center">
            {/* Target box */}
            <div className="scanner-target-box relative w-64 h-64 border-4 border-blue-500 rounded-lg">
              {/* Corner decorations */}
              <div className="absolute -top-1 -left-1 w-8 h-8 border-t-4 border-l-4 border-white rounded-tl-lg"></div>
              <div className="absolute -top-1 -right-1 w-8 h-8 border-t-4 border-r-4 border-white rounded-tr-lg"></div>
              <div className="absolute -bottom-1 -left-1 w-8 h-8 border-b-4 border-l-4 border-white rounded-bl-lg"></div>
              <div className="absolute -bottom-1 -right-1 w-8 h-8 border-b-4 border-r-4 border-white rounded-br-lg"></div>

              {/* Scanning line animation */}
              <div className="scanner-line absolute top-0 left-0 w-full h-1 bg-blue-400 animate-scan"></div>
            </div>

            {/* Hint text */}
            <p className="scanner-hint absolute bottom-8 left-0 right-0 text-center text-white text-sm bg-black bg-opacity-50 px-4 py-2 mx-4 rounded">
              {allowedTypes && allowedTypes.length === 1
                ? `Scan ${allowedTypes[0].replace(/-/g, ' ')} QR code`
                : 'Scan QR code for invitation or proof request'}
            </p>
          </div>
        )}

        {/* Success state */}
        {!scanning && !error && (
          <div className="scanner-success absolute inset-0 flex items-center justify-center bg-green-500 bg-opacity-90">
            <div className="text-center text-white">
              <div className="text-6xl mb-4">✓</div>
              <p className="text-xl font-semibold">QR Code Scanned!</p>
              <p className="text-sm mt-2">Processing...</p>
            </div>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="scanner-error absolute inset-0 flex items-center justify-center bg-red-500 bg-opacity-90 p-6">
            <div className="text-center text-white max-w-md">
              <div className="text-6xl mb-4">⚠</div>
              <p className="text-lg font-semibold mb-2">Scan Error</p>
              <p className="text-sm">{error}</p>
              <button
                onClick={resetScanner}
                className="mt-4 px-6 py-2 bg-white text-red-600 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Scanner controls */}
      {scanning && (
        <div className="scanner-controls mt-4 flex justify-center gap-3">
          <button
            onClick={() => setIsPaused(!isPaused)}
            className="px-4 py-2 bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 text-slate-300 rounded-xl transition-colors"
          >
            {isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
        </div>
      )}

      {/* Custom styles for animations */}
      <style jsx>{`
        @keyframes scan {
          0% {
            transform: translateY(0);
            opacity: 0;
          }
          50% {
            opacity: 1;
          }
          100% {
            transform: translateY(256px);
            opacity: 0;
          }
        }

        .animate-scan {
          animation: scan 2s ease-in-out infinite;
        }

        .scanner-view {
          min-height: 400px;
          background: #000;
          border-radius: 8px;
          overflow: hidden;
        }
      `}</style>
    </div>
  );
};

export default Scanner;
