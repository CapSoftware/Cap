import { useState, useEffect } from 'react';
import { invoke as TAURI_INVOKE } from "@tauri-apps/api/core";

export const useUploadSpeed = () => {
  const [uploadSpeed, setUploadSpeed] = useState<number | null>(null);
  const [message, setMessage] = useState({ text: 'Checking upload speed...', color: 'black' });

  useEffect(() => {
    const getUploadSpeed = async () => {
      try {
        const speed = await TAURI_INVOKE<number>('get_upload_speed');
        setUploadSpeed(speed);

        if (speed < 1) {
          setMessage({
            text: `Upload Speed: ${speed.toFixed(2)} Mbps.
            Slow upload speed detected. This may affect your ability to upload files.`,
            color: 'red'
          });
        } else {
          setMessage({
            text: `Upload speed is Good (${speed.toFixed(2)} Mbps).`,
            color: 'green'
          });
        }
      } catch (error) {
        console.error('Failed to get upload speed:', error);
        setUploadSpeed(null);
        setMessage({
          text: 'Failed to measure upload speed',
          color: 'red'
        });
      }
    };

    getUploadSpeed();
  }, []);

  return { uploadSpeed, message };
};
