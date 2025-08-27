"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type RecordingState = "idle" | "recording" | "stopped";
type RecordingSource = "screen" | "window" | "area";
type MediaDevice = {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
};

interface UseRecordingProps {
  selectedSource: RecordingSource;
  selectedCamera: MediaDevice | null;
  selectedMicrophone: MediaDevice | null;
  isSystemAudioEnabled: boolean;
}

export function useRecording({
  selectedSource,
  selectedCamera,
  selectedMicrophone,
  isSystemAudioEnabled,
}: UseRecordingProps) {
  // Create camera preview stream when camera is selected
  useEffect(() => {
    const createPreviewStream = async () => {
      // Clean up existing preview stream
      if (previewStreamRef.current) {
        previewStreamRef.current.getTracks().forEach(track => track.stop());
        previewStreamRef.current = null;
        setCameraPreviewStream(null);
      }

      if (selectedCamera) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 320 },
              height: { ideal: 240 },
              deviceId: selectedCamera.deviceId,
            },
            audio: false,
          });
          previewStreamRef.current = stream;
          setCameraPreviewStream(stream);
        } catch (err) {
          console.error("Failed to create camera preview:", err);
        }
      }
    };

    createPreviewStream();
  }, [selectedCamera]);
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [cameraPreviewStream, setCameraPreviewStream] = useState<MediaStream | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const startRecording = useCallback(() => {
    // Prevent multiple simultaneous recording attempts
    if (isStartingRecording || recordingState !== "idle") {
      return;
    }
    
    setIsStartingRecording(true);
    startActualRecording();
  }, []);

  const startActualRecording = useCallback(async () => {
    try {
      const baseVideoConstraints = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      };

      const displayMediaOptions: DisplayMediaStreamOptions = {
        video: selectedSource === "area" ? {
          ...baseVideoConstraints,
          displaySurface: "monitor" as const,
        } : baseVideoConstraints,
        audio: isSystemAudioEnabled,
      };

      const displayStream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaOptions
      );

      streamRef.current = displayStream;

      if (selectedMicrophone) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: selectedMicrophone.deviceId,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });

          const audioContext = new AudioContext();
          const micSource = audioContext.createMediaStreamSource(micStream);
          const destination = audioContext.createMediaStreamDestination();
          micSource.connect(destination);

          const displayAudioTracks = displayStream.getAudioTracks();
          if (displayAudioTracks.length > 0) {
            const displaySource = audioContext.createMediaStreamSource(
              new MediaStream(displayAudioTracks)
            );
            displaySource.connect(destination);
          }

          const mixedAudioTrack = destination.stream.getAudioTracks()[0];
          if (mixedAudioTrack) {
            for (const track of displayStream.getAudioTracks()) {
              displayStream.removeTrack(track);
              track.stop();
            }
            displayStream.addTrack(mixedAudioTrack);
          }

          for (const track of micStream.getTracks()) {
            track.stop();
          }
        } catch (err) {
          console.error("Failed to add microphone:", err);
          toast.error("Failed to access microphone");
        }
      }

      if (selectedCamera) {
        try {
          const webcamStream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 320 },
              height: { ideal: 240 },
              deviceId: selectedCamera.deviceId,
            },
            audio: false,
          });
          webcamStreamRef.current = webcamStream;
        } catch (err) {
          console.error("Failed to access webcam:", err);
          toast.error("Failed to access webcam");
        }
      }

      const options = {
        mimeType: "video/webm;codecs=vp8,opus" as string,
        videoBitsPerSecond: 2500000,
      } as MediaRecorderOptions & { mimeType: string };

      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = "video/webm";
      }

      const mediaRecorder = new MediaRecorder(displayStream, options);
      mediaRecorderRef.current = mediaRecorder;
      recordedChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        setRecordedBlob(blob);
        setRecordingState("stopped");
        
        if (recordingIntervalRef.current) {
          clearInterval(recordingIntervalRef.current);
        }
      };

      const videoTrack = displayStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          stopRecording();
        };
      }

      mediaRecorder.start(1000);
      setRecordingState("recording");
      setIsStartingRecording(false);
      recordingStartTimeRef.current = Date.now();
      
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(
          Math.floor((Date.now() - recordingStartTimeRef.current) / 1000)
        );
      }, 100);
    } catch (err: any) {
      console.error("Error starting recording:", err);
      
      setIsStartingRecording(false);
      
      // Check if user cancelled the screen share dialog
      if (err.name === "NotAllowedError" || err.message.includes("cancelled")) {
        // User cancelled, don't show error toast and reset cleanly
        setRecordingState("idle");
      } else {
        // Actual error occurred
        toast.error("Failed to start recording");
        setRecordingState("idle");
      }
    }
  }, [selectedSource, isSystemAudioEnabled, selectedMicrophone, selectedCamera]);

  const stopRecording = useCallback(() => {
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
    }

    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
    }

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
    }
    
    if (webcamStreamRef.current) {
      for (const track of webcamStreamRef.current.getTracks()) {
        track.stop();
      }
    }
    
    if (previewStreamRef.current) {
      for (const track of previewStreamRef.current.getTracks()) {
        track.stop();
      }
      previewStreamRef.current = null;
      setCameraPreviewStream(null);
    }
  }, []);

  const resetRecording = useCallback(() => {
    setRecordingState("idle");
    setRecordingTime(0);
    setRecordedBlob(null);
    setIsStartingRecording(false);
    setCameraPreviewStream(null);
    recordedChunksRef.current = [];
    
    if (previewStreamRef.current) {
      previewStreamRef.current.getTracks().forEach(track => track.stop());
      previewStreamRef.current = null;
    }
    
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
    }
  }, []);

  return {
    recordingState,
    recordingTime,
    recordedBlob,
    isStartingRecording,
    cameraPreviewStream,
    startRecording,
    stopRecording,
    resetRecording,
  };
}