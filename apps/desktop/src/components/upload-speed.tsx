import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useUploadSpeed } from '../utils/hooks/useUploadSpeed'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, DialogFooter } from '@cap/ui'

export const UploadSpeed: React.FC = () => {
  const { uploadSpeed, message } = useUploadSpeed()
  const [showMessage, setShowMessage] = useState(false)

  const status = useMemo(() => {
    if (uploadSpeed === null) return { isHealthy: false, isPoor: false, text: 'Fail' }
    const isHealthy = uploadSpeed >= 1
    const isPoor = uploadSpeed < 1
    return {
      isHealthy,
      isPoor,
      text: isHealthy ? 'Good' : isPoor ? 'Poor' : 'Fail'
    }
  }, [uploadSpeed])

  const statusColor = useMemo(() => {
    if (status.isHealthy) return 'text-green-500'
    if (status.isPoor) return 'text-yellow-600'
    return 'text-red-500'
  }, [status.isHealthy, status.isPoor])

  return (
    <div className="bg-white rounded-lg shadow-md">
      <div onClick={() => setShowMessage(true)} className="flex items-center">
        <span className="text-xs font-medium">Upload Speed:</span>
        <span className={`text-xs font-bold ${statusColor}`}>
          {uploadSpeed !== null ? `${uploadSpeed.toFixed(2)} Mbps` : '❌'}
        </span>
        <span className={`text-xs ${statusColor}`}>
          ({status.text})
        </span>
      </div>
      
      <Dialog
        open={showMessage}
        onOpenChange={setShowMessage}
      >
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="text-base font-semibold">Upload Speed Status</DialogTitle>
          <DialogDescription>
            <div>
              <p className="text-sm text-gray-600 text-justify">{message.text}</p>
              {!status.isHealthy && (
                <div className="bg-gray-100 rounded-md">
                  <p className="text-xs font-medium text-justify">
                    If you are experiencing poor upload speeds or failed to get it, try the following:
                  </p>
                  <ul className="list-disc list-inside text-xs text-gray-600">
                    <li>Check your internet connection</li>
                    <li>Close unnecessary applications</li>
                    <li>Try uploading at a different time</li>
                  </ul>
                  <p className="text-xs text-justify">
                    If the issue persists, please contact our{' '}
                    <span title="Get help from our support team">
                      <a href="/support" className="text-blue-500 hover:underline">support team</a>
                    </span>.
                  </p>
                </div> 
              )}
            </div>
          </DialogDescription>
          <DialogFooter>
            <Button onClick={() => setShowMessage(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}