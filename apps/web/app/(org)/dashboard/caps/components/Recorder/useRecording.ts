"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { createVideoAndGetUploadUrl } from "@/actions/video/upload";

type RecordingState = "idle" | "recording" | "stopped" | "uploading";
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
  useEffect(() => {
    const createPreviewStream = async () => {
      if (previewStreamRef.current) {
        previewStreamRef.current.getTracks().forEach(track => { track.stop(); });
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
  const [uploadProgress, setUploadProgress] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const convertToMp4 = useCallback(async (webmBlob: Blob): Promise<Blob> => {
    try {
      console.log('Converting WebM to MP4 using Remotion WebCodecs');
      
      const parser = await import("@remotion/media-parser");
      const webcodecs = await import("@remotion/webcodecs");

      const metadata = await parser.parseMedia({
        src: webmBlob,
        fields: {
          durationInSeconds: true,
          dimensions: true,
          videoCodec: true,
          audioCodec: true,
        },
      });

      console.log('WebM metadata for conversion:', metadata);

      const canUseWebCodecs =
        typeof VideoDecoder !== "undefined" &&
        typeof AudioDecoder !== "undefined" &&
        typeof ArrayBuffer.prototype.resize === "function";

      if (!canUseWebCodecs) {
        console.warn('WebCodecs not supported, returning original WebM blob');
        return webmBlob;
      }

      const convertResult = await webcodecs.convertMedia({
        src: webmBlob,
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        onProgress: ({ overallProgress }) => {
          if (overallProgress !== null) {
            console.log(`Conversion progress: ${Math.round(overallProgress * 100)}%`);
          }
        },
      });

      const mp4Blob = await convertResult.save();

      if (mp4Blob.size === 0) {
        console.warn('Conversion produced empty file, returning original');
        return webmBlob;
      }

      const isValidMp4 = await new Promise<boolean>((resolve) => {
        const testVideo = document.createElement("video");
        testVideo.muted = true;
        testVideo.playsInline = true;
        testVideo.preload = "metadata";

        const timeout = setTimeout(() => {
          console.warn("MP4 validation timed out, using anyway");
          URL.revokeObjectURL(testVideo.src);
          resolve(true);
        }, 10000);

        const validateVideo = () => {
          const hasValidDuration =
            testVideo.duration > 0 &&
            !Number.isNaN(testVideo.duration) &&
            Number.isFinite(testVideo.duration);

          const hasValidDimensions =
            (testVideo.videoWidth > 0 && testVideo.videoHeight > 0) ||
            (metadata.dimensions ? 
              (metadata.dimensions.width > 0 && metadata.dimensions.height > 0) : 
              false);

          clearTimeout(timeout);
          URL.revokeObjectURL(testVideo.src);
          resolve(hasValidDuration && hasValidDimensions);
        };

        testVideo.addEventListener("loadedmetadata", validateVideo);
        testVideo.addEventListener("error", () => {
          console.warn('MP4 validation failed, returning original WebM');
          clearTimeout(timeout);
          URL.revokeObjectURL(testVideo.src);
          resolve(false);
        });

        testVideo.src = URL.createObjectURL(mp4Blob);
      });

      if (isValidMp4) {
        console.log('MP4 conversion successful');
        return mp4Blob;
      } else {
        console.warn('MP4 validation failed, returning original WebM');
        return webmBlob;
      }

    } catch (error) {
      console.error("MP4 conversion failed:", error);
      console.log('Falling back to original WebM blob');
      return webmBlob;
    }
  }, []);

  const generateThumbnail = useCallback(async (videoBlob: Blob, videoId: string): Promise<void> => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    if (!ctx) return;

    const url = URL.createObjectURL(videoBlob);
    video.src = url;
    
    return new Promise((resolve, reject) => {
      video.onloadedmetadata = () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        video.currentTime = Math.min(1, video.duration / 2);
      };
      
      video.onseeked = async () => {
        try {
          ctx.drawImage(video, 0, 0);
          
          canvas.toBlob(async (thumbnailBlob) => {
            if (!thumbnailBlob) {
              reject(new Error('Failed to generate thumbnail'));
              return;
            }

            const { presignedPostData } = await createVideoAndGetUploadUrl({
              videoId,
              isScreenshot: true
            });
            
            const formData = new FormData();
            Object.entries(presignedPostData.fields).forEach(([key, value]) => {
              formData.append(key, value);
            });
            formData.append('file', thumbnailBlob, 'screen-capture.jpg');

            const uploadResponse = await fetch(presignedPostData.url, {
              method: 'POST',
              body: formData,
            });

            if (!uploadResponse.ok) {
              throw new Error(`Thumbnail upload failed: ${uploadResponse.status}`);
            }
            
            URL.revokeObjectURL(url);
            resolve();
          }, 'image/jpeg', 0.8);
        } catch (error) {
          URL.revokeObjectURL(url);
          reject(error);
        }
      };
      
      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load video for thumbnail'));
      };
    });
  }, []);

  const uploadVideo = useCallback(async (videoBlob: Blob): Promise<void> => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(videoBlob);
    video.src = url;
    
    return new Promise((resolve, reject) => {
      video.onloadedmetadata = async () => {
        try {
          const rawDuration = video.duration;
          const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : undefined;
          const resolution = `${video.videoWidth}x${video.videoHeight}`;
          
          if (duration && duration > 300) {
            console.warn(`Recording duration ${duration}s exceeds free limit of 300s`);
          }
          
          const { id: videoId, presignedPostData } = await createVideoAndGetUploadUrl({
            duration,
            resolution,
            videoCodec: 'h264',
            audioCodec: 'aac',
            isUpload: false
          });

          const mp4Blob = await convertToMp4(videoBlob);
          
          const formData = new FormData();
          Object.entries(presignedPostData.fields).forEach(([key, value]) => {
            formData.append(key, value);
          });
          formData.append('file', mp4Blob, 'result.mp4');

          setUploadProgress(25);
          
          const uploadResponse = await fetch(presignedPostData.url, {
            method: 'POST',
            body: formData,
          });
          
          setUploadProgress(75);

          if (!uploadResponse.ok) {
            throw new Error(`Upload failed: ${uploadResponse.status}`);
          }

          await generateThumbnail(videoBlob, videoId);
          setUploadProgress(100);
          
          URL.revokeObjectURL(url);
          resolve();
        } catch (error) {
          URL.revokeObjectURL(url);
          reject(error);
        }
      };
      
      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load video metadata'));
      };
    });
  }, [convertToMp4, generateThumbnail]);

  const stopRecording = useCallback(() => {
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }

    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
      });
      streamRef.current = null;
    }
    
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach(track => {
        track.stop();
      });
      webcamStreamRef.current = null;
    }
    
    if (previewStreamRef.current) {
      previewStreamRef.current.getTracks().forEach(track => {
        track.stop();
      });
      previewStreamRef.current = null;
      setCameraPreviewStream(null);
    }
  }, []);

  const startActualRecording = useCallback(async () => {
    try {
      const baseVideoConstraints = {
        width: { ideal: 2560, min: 1920 },
        height: { ideal: 1440, min: 1080 },
        frameRate: { ideal: 30, min: 24 },
      };

      const displayMediaOptions: DisplayMediaStreamOptions = {
        video: selectedSource === "area" ? {
          ...baseVideoConstraints,
          displaySurface: "monitor" as const,
        } : baseVideoConstraints,
        audio: isSystemAudioEnabled || !!selectedMicrophone,
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
              sampleRate: 44100,
              sampleSize: 16,
            },
          });

          const audioContext = new AudioContext({ sampleRate: 44100 });
          const destination = audioContext.createMediaStreamDestination();
          
          const micSource = audioContext.createMediaStreamSource(micStream);
          const micGain = audioContext.createGain();
          micGain.gain.value = 1.0;
          micSource.connect(micGain);
          micGain.connect(destination);

          const displayAudioTracks = displayStream.getAudioTracks();
          if (displayAudioTracks.length > 0 && isSystemAudioEnabled) {
            const displayAudioStream = new MediaStream(displayAudioTracks);
            const displaySource = audioContext.createMediaStreamSource(displayAudioStream);
            const systemGain = audioContext.createGain();
            systemGain.gain.value = 0.8;
            displaySource.connect(systemGain);
            systemGain.connect(destination);
          }

          const mixedAudioTrack = destination.stream.getAudioTracks()[0];
          if (mixedAudioTrack) {
            displayStream.getAudioTracks().forEach(track => {
              displayStream.removeTrack(track);
              track.stop();
            });
            displayStream.addTrack(mixedAudioTrack);
          }

          webcamStreamRef.current = micStream;
        } catch (err) {
          console.error("Failed to add microphone:", err);
          toast.error("Failed to access microphone. Please check your microphone permissions and try again.");
        }
      } else if (!isSystemAudioEnabled) {
        const displayAudioTracks = displayStream.getAudioTracks();
        displayAudioTracks.forEach(track => {
          displayStream.removeTrack(track);
          track.stop();
        });
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

      const videoTrackSettings = displayStream.getVideoTracks()[0]?.getSettings();
      const resolution = videoTrackSettings ? 
        videoTrackSettings.width! * videoTrackSettings.height! : 
        1920 * 1080;
      
      let videoBitrate: number;
      if (resolution >= 2560 * 1440) {
        videoBitrate = 8000000;
      } else if (resolution >= 1920 * 1080) {
        videoBitrate = 5000000;
      } else if (resolution >= 1280 * 720) {
        videoBitrate = 3500000;
      } else {
        videoBitrate = 2500000;
      }

      const codecs = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=h264,opus",
        "video/webm"
      ];
      
      let selectedMimeType = "video/webm";
      for (const codec of codecs) {
        if (MediaRecorder.isTypeSupported(codec)) {
          selectedMimeType = codec;
          break;
        }
      }

      const options = {
        mimeType: selectedMimeType,
        videoBitsPerSecond: videoBitrate,
        audioBitsPerSecond: 128000,
      } as MediaRecorderOptions & { mimeType: string; audioBitsPerSecond?: number };

      console.log('Recording with settings:', {
        codec: selectedMimeType,
        videoBitrate: `${videoBitrate / 1000000}Mbps`,
        audioBitrate: '128kbps',
        resolution: videoTrackSettings ? 
          `${videoTrackSettings.width}x${videoTrackSettings.height}` : 
          'unknown',
        frameRate: videoTrackSettings?.frameRate || 'unknown'
      });

      const mediaRecorder = new MediaRecorder(displayStream, options);
      mediaRecorderRef.current = mediaRecorder;
      recordedChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        setRecordedBlob(blob);
        setRecordingState("uploading");
        
        if (recordingIntervalRef.current) {
          clearInterval(recordingIntervalRef.current);
        }

        try {
          await uploadVideo(blob);
          setRecordingState("stopped");
        } catch (error) {
          console.error("Upload failed:", error);
          if ((error as Error)?.message === 'upgrade_required') {
            toast.error("Recording too long. Upgrade to Pro for unlimited recording.");
          } else {
            toast.error("Failed to upload video");
          }
          setRecordingState("stopped");
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
    } catch (err: unknown) {
      console.error("Error starting recording:", err);
      
      setIsStartingRecording(false);
      
      if ((err as Error)?.name === "NotAllowedError" || (err as Error)?.message?.includes("cancelled")) {
        setRecordingState("idle");
      } else {
        toast.error("Failed to start recording");
        setRecordingState("idle");
      }
    }
  }, [selectedSource, isSystemAudioEnabled, selectedMicrophone, selectedCamera, uploadVideo, stopRecording]);

  const startRecording = useCallback(() => {
    if (isStartingRecording || recordingState !== "idle") {
      return;
    }
    
    setIsStartingRecording(true);
    startActualRecording();
  }, [isStartingRecording, recordingState, startActualRecording]);

  const resetRecording = useCallback(() => {
    setRecordingState("idle");
    setRecordingTime(0);
    setRecordedBlob(null);
    setIsStartingRecording(false);
    setCameraPreviewStream(null);
    setUploadProgress(0);
    recordedChunksRef.current = [];
    
    if (previewStreamRef.current) {
      previewStreamRef.current.getTracks().forEach(track => { track.stop(); });
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
    uploadProgress,
    startRecording,
    stopRecording,
    resetRecording,
  };
}