




import { useState, useEffect } from 'react';
import { invoke as TAURI_INVOKE } from "@tauri-apps/api/core";

export const useHealthCheck = () => {
  const [isHealthy, setIsHealthy] = useState(true);
  const [message, setMessage] = useState(`
    Upload issue detected. Please check your internet connection.
    If you still having an issue, please contact our support.
  `);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const health = await TAURI_INVOKE('get_health_check_status');
        setIsHealthy(health as boolean);

        if (!health) {
          setMessage(`
            Upload issue detected. Please check your internet connection.
          `);
        } else {
          setMessage('Looks good. Proceed with recording and uploading.');
        }
      } catch (error) {
        console.error('Failed to get health check status:', error);
        setIsHealthy(false);
        setMessage('Failed to perform health check');
      }
    };

    checkHealth();
  }, []);

  return { isHealthy, message };
};

