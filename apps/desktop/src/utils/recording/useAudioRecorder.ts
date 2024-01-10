import { useState, useRef } from "react";
import { appDataDir, join } from "@tauri-apps/api/path";
import { writeBinaryFile } from "@tauri-apps/api/fs";
import { MediaDeviceContextData } from "@/utils/recording/MediaDeviceContext";
import { getLocalDevices } from "@/utils/recording/utils";

export const useAudioRecorder = () => {
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<BlobPart[]>([]);

  const startAudioRecording = async (
    selectedAudioDevice: MediaDeviceContextData["selectedAudioDevice"]
  ) => {
    if (!selectedAudioDevice) {
      console.error("No audio device selected");
      throw new Error("No audio device selected");
    }

    const { audioDevices } = await getLocalDevices();
    const audioDeviceInfo = audioDevices.find(
      (device) =>
        device.kind === "audioinput" &&
        device.label === selectedAudioDevice.label
    );

    if (!audioDeviceInfo) {
      throw new Error("Cannot find audio device info");
    }

    const audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: audioDeviceInfo.deviceId },
    });

    mediaRecorder.current = new MediaRecorder(audioStream);

    if (mediaRecorder.current === null) {
      console.error("mediaRecorder is null.");
      return;
    }

    mediaRecorder.current.start();
    setIsRecordingAudio(true);

    mediaRecorder.current.ondataavailable = (event) => {
      audioChunks.current.push(event.data);
    };

    mediaRecorder.current.onerror = (event: any) => {
      console.error("Recording error:", event.error);
      setIsRecordingAudio(false);
    };
  };

  const stopAudioRecording = () => {
    return new Promise<string>((resolve, reject) => {
      if (mediaRecorder.current && isRecordingAudio) {
        mediaRecorder.current.stop();

        // Event handler for when recording stops
        mediaRecorder.current.onstop = async () => {
          try {
            const audioBlob = new Blob(audioChunks.current, {
              type: "audio/mp3",
            });
            const buffer = await audioBlob.arrayBuffer();
            const dir = await appDataDir();
            const filePath = await join(
              dir,
              `cap_audio_${new Date().toISOString()}.mp3`
            );

            await writeBinaryFile({
              path: filePath,
              contents: new Uint8Array(buffer),
            });
            audioChunks.current = []; // Clear audio chunks
            setIsRecordingAudio(false); // Update the recording state

            // Resolve the promise with the file path
            resolve(filePath);
          } catch (error) {
            console.error("Error writing audio file:", error);
            reject(error);
          }
        };

        // Event handler for errors
        mediaRecorder.current.onerror = (event: any) => {
          console.error("Recording error:", event.error);
          reject(event.error);
        };
      } else {
        console.error(
          "stopAudioRecording was called but the mediaRecorder is not recording"
        );
        reject(new Error("MediaRecorder is not recording."));
      }
    });
  };

  return {
    isRecordingAudio,
    startAudioRecording,
    stopAudioRecording,
  };
};
