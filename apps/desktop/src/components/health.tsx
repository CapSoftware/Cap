import React, { useState } from 'react';
import { useHealthCheck } from '../utils/hooks/useHealthCheck';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogFooter } from '@cap/ui';

export const HealthCheckStatus: React.FC = () => {
  const { isHealthy, message } = useHealthCheck();
  const [showMessage, setShowMessage] = useState(false);

  const handleClick = () => {
    setShowMessage(true);
  };

  return (
    <div className="flex items-center space-x-2">
      <button
        onClick={handleClick}
        className={`w-4 h-4 rounded-full ${isHealthy ? 'bg-green-500' : 'bg-red-500'}`}
        aria-label="Health Check Status"
        title={isHealthy ? "System is healthy" : "System health issue detected"}
      />
      <Dialog
        open={showMessage}
        onOpenChange={setShowMessage}
      >
        <DialogContent>
          <DialogTitle>Health Check Status</DialogTitle>
          <DialogDescription>
            {message}
            {!isHealthy && (
              <p className="text-sm mt-2">
                If you are still having an issue, please contact our 
                <a href="/support" className="text-blue-500 hover:underline ml-1">support</a>.
              </p>
            )}
          </DialogDescription>
          <DialogFooter>
            <button
              onClick={() => setShowMessage(false)}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};