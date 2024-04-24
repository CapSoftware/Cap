"use client";

//
// WARNING!!
// WARNING!!
// WARNING!!
// WARNING!!
//
// This code is currently quite horrific.
// It is a work in progress and will be refactored.
// Pls do not judge me.
// Shipping > perfection.
//
//
//
//
//
//

import { useState, useEffect, useRef } from "react";
import { users } from "@cap/database/schema";
import { Mic, Video, Monitor, ArrowLeft } from "lucide-react";
import { Rnd } from "react-rnd";
import {
  Button,
  Logo,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  LogoSpinner,
} from "@cap/ui";
import { ActionButton } from "./_components/ActionButton";
import toast from "react-hot-toast";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { getLatestVideoId, saveLatestVideoId } from "@cap/utils";
import { FileData } from "@ffmpeg/ffmpeg/dist/esm/types";

class AsyncTaskQueue {
  private queue: (() => Promise<void>)[] = [];
  private isProcessing = false;
  private resolveEmpty: (() => void) | null = null;
  private emptyPromise = new Promise<void>(
    (resolve) => (this.resolveEmpty = resolve)
  );

  async enqueue(task: () => Promise<void>) {
    this.queue.push(task);
    if (!this.isProcessing) {
      await this.processQueue();
    }
  }

  private async processQueue() {
    this.isProcessing = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        await task();
      }
    }
    this.isProcessing = false;
    if (this.resolveEmpty) {
      this.resolveEmpty();
      this.emptyPromise = new Promise<void>(
        (resolve) => (this.resolveEmpty = resolve)
      );
    }
  }

  public async waitForEmpty() {
    if (this.queue.length === 0 && !this.isProcessing) {
      return Promise.resolve();
    }
    return this.emptyPromise;
  }
}

// million-ignore
export const Record = ({
  user,
}: {
  user: typeof users.$inferSelect | null;
}) => {
  const ffmpegRef = useRef(new FFmpeg());
  const [isLoading, setIsLoading] = useState(true);
  const [startingRecording, setStartingRecording] = useState(false);
  const [stoppingRecording, setStoppingRecording] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [currentStoppingMessage, setCurrentStoppingMessage] =
    useState("Stopping Recording");
  const [recordingTime, setRecordingTime] = useState("00:00");

  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<string>();
  const [selectedVideoDevice, setSelectedVideoDevice] = useState<string>();
  const [selectedAudioDeviceLabel, setSelectedAudioDeviceLabel] =
    useState("Microphone");
  const [selectedVideoDeviceLabel, setSelectedVideoDeviceLabel] =
    useState("Webcam");
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [videoRecorder, setVideoRecorder] = useState<MediaRecorder | null>(
    null
  );
  const totalSegments = useRef(0);
  const segmentStartTimeRef = useRef(0);
  const muxQueue = new AsyncTaskQueue();
  const screenPreviewRef = useRef<HTMLVideoElement>(null);
  const webcamPreviewRef = useRef<HTMLVideoElement>(null);
  const [aspectRatio, setAspectRatio] = useState(1.7777777778);
  const [webcamStyleSettings, setWebcamStyleSettings] = useState({
    x: 16,
    y: 16,
    width: 180,
    height: 180,
  });
  const [screenStyleSettings, setScreenStyleSettings] = useState({
    x: 0,
    y: 0,
    width: "100%" as any,
    height: "100%" as any,
  });

  const [isCenteredHorizontally, setIsCenteredHorizontally] = useState(false);
  const [isCenteredVertically, setIsCenteredVertically] = useState(false);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const defaultRndHandeStyles = {
    topLeft: {
      width: "16px",
      height: "16px",
      borderRadius: "50%",
      backgroundColor: "white",
      border: "2px solid #ddd",
      zIndex: 999,
      boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)",
    },
    topRight: {
      width: "16px",
      height: "16px",
      borderRadius: "50%",
      backgroundColor: "white",
      border: "2px solid #ddd",
      zIndex: 999,
      boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)",
    },
    bottomLeft: {
      width: "16px",
      height: "16px",
      borderRadius: "50%",
      backgroundColor: "white",
      border: "2px solid #ddd",
      zIndex: 999,
      boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)",
    },
    bottomRight: {
      width: "16px",
      height: "16px",
      borderRadius: "50%",
      backgroundColor: "white",
      border: "2px solid #ddd",
      zIndex: 999,
      boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)",
    },
  };

  useEffect(() => {
    const loadFFmpeg = async () => {
      setIsLoading(true);
      const ffmpeg = ffmpegRef.current;

      console.log("Loading FFmpeg");

      await ffmpeg.load();
      setIsLoading(false);

      console.log("FFmpeg loaded");
    };

    loadFFmpeg();
  }, []);

  const getDevices = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      console.log("Devices:", devices);
      const audioDevices = devices.filter(
        (device) => device.kind === "audioinput"
      );
      const videoDevices = devices.filter(
        (device) => device.kind === "videoinput"
      );
      setAudioDevices(audioDevices);
      setVideoDevices(videoDevices);
    } catch (error) {
      console.error("Error accessing media devices:", error);
    }
  };

  const startScreenCapture = async () => {
    try {
      const displayMediaOptions = {
        video: {
          displaySurface: "window",
        },
        audio: false,
        surfaceSwitching: "exclude",
        selfBrowserSurface: "exclude",
        systemAudio: "exclude",
      };

      const stream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaOptions
      );
      const videoElement = document.createElement("video");
      videoElement.srcObject = stream;

      return new Promise((resolve) => {
        videoElement.onloadedmetadata = () => {
          const { videoWidth, videoHeight } = videoElement;
          const aspectRatio = videoWidth / videoHeight;
          setAspectRatio(aspectRatio);
          setScreenStream(stream);
          console.log("videoWidth", videoWidth);
          console.log("videoHeight", videoHeight);
          console.log("aspectRatio", aspectRatio);
          setScreenStyleSettings({
            x: 0,
            y: 0,
            width: "100%",
            height: "100%",
          });
          startVideoCapture(selectedVideoDevice, "small");
          resolve({ width: videoWidth, height: videoHeight });
        };
      });
    } catch (error) {
      console.error("Error capturing screen:", error);
    }
  };

  const startVideoCapture = async (
    deviceId?: string,
    placement?: "small" | "large"
  ) => {
    try {
      const constraints: MediaStreamConstraints = {
        video: deviceId ? { deviceId } : true,
        audio: selectedAudioDevice ? { deviceId: selectedAudioDevice } : false,
      };

      console.log("Video constraints:", constraints);

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setVideoStream(stream);

      const videoContainer = document.querySelector(
        ".video-container"
      ) as HTMLElement;

      if (videoContainer === null) {
        console.error("Video container dimensions not found");
        return;
      }

      const videoContainerWidth = videoContainer.clientWidth;
      const videoContainerHeight = videoContainer.clientHeight;

      if (placement === "large") {
        setWebcamStyleSettings({
          x: (videoContainerWidth - videoContainerWidth / 2) / 2,
          y: (videoContainerHeight - videoContainerWidth / 2) / 2,
          width: videoContainerWidth / 2,
          height: videoContainerWidth / 2,
        });
      } else if (placement === "small") {
        const webcamWidth = 180;

        setWebcamStyleSettings({
          x: 16,
          y: videoContainer.clientHeight - 16 - webcamWidth,
          width: webcamWidth,
          height: webcamWidth,
        });
      }
    } catch (error) {
      console.error("Error capturing video:", error);
    }
  };

  const stopScreenCapture = () => {
    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
      setScreenStream(null);
    }
  };

  const stopVideoCapture = () => {
    if (videoStream) {
      videoStream.getTracks().forEach((track) => track.stop());
      setVideoStream(null);
    }
  };

  const startRecording = async () => {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_URL}/api/desktop/video/create`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      }
    );

    if (res.status === 401) {
      console.error("Unauthorized");
      toast.error("Unauthorized - please sign in again.");
      return;
    }

    const videoCreateData = await res.json();

    if (
      !videoCreateData.id ||
      !videoCreateData.user_id ||
      !videoCreateData.aws_region ||
      !videoCreateData.aws_bucket
    ) {
      console.error("No data received");
      toast.error("No data received - please try again later.");
      return;
    }

    saveLatestVideoId(videoCreateData.id);

    if (!screenStream || !videoStream) {
      console.error("No screen or video stream");
      toast.error("No screen or video stream - please try again.");
      return;
    }

    setStartingRecording(true);

    const combinedStream = new MediaStream();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    // Get the video container element
    const videoContainer = document.querySelector(
      ".video-container"
    ) as HTMLElement;

    // Set the minimum width to 1000 pixels
    const minWidth = 1000;

    // Calculate the aspect ratio of the video container
    const aspectRatio =
      videoContainer.clientWidth / videoContainer.clientHeight;

    // Set the canvas width to the minimum width or the video container width, whichever is larger
    canvas.width = Math.max(minWidth, videoContainer.clientWidth);

    // Calculate the canvas height based on the width and aspect ratio
    canvas.height = canvas.width / aspectRatio;

    let animationFrameId: number;

    const drawCanvas = () => {
      if (ctx) {
        // Clear the canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Get the current position and size of the screen preview
        const screenPreview = document.getElementById(
          "screenPreview"
        ) as HTMLVideoElement;
        const screenRect = screenPreview.getBoundingClientRect();
        const containerRect = document
          .querySelector(".video-container")
          ?.getBoundingClientRect();

        if (containerRect) {
          const screenX = screenRect.left - containerRect.left;
          const screenY = screenRect.top - containerRect.top;
          const screenWidth = screenRect.width;
          const screenHeight = screenRect.height;

          // Draw the screen preview on the canvas based on its position and size
          ctx.drawImage(
            screenPreview,
            screenX,
            screenY,
            screenWidth,
            screenHeight
          );
        }

        // Get the current position and size of the webcam preview
        const webcamPreview = document.getElementById(
          "webcamPreview"
        ) as HTMLVideoElement;
        const webcamRect = webcamPreview.getBoundingClientRect();

        if (containerRect) {
          const camX = webcamRect.left - containerRect.left;
          const camY = webcamRect.top - containerRect.top;
          const camWidth = webcamRect.width;
          const camHeight = webcamRect.height;

          // Calculate the aspect ratio of the webcam video
          const videoAspectRatio =
            webcamPreview.videoWidth / webcamPreview.videoHeight;

          // Calculate the new dimensions to maintain the aspect ratio
          let newCamWidth = camWidth;
          let newCamHeight = camHeight;
          if (camWidth / camHeight > videoAspectRatio) {
            newCamWidth = camHeight * videoAspectRatio;
          } else {
            newCamHeight = camWidth / videoAspectRatio;
          }

          // Calculate the offset to center the webcam video
          const offsetX = (camWidth - newCamWidth) / 2;
          const offsetY = (camHeight - newCamHeight) / 2;

          // Set the position and size of the circular webcam preview on the canvas
          ctx.save();
          ctx.beginPath();
          ctx.arc(
            camX + camWidth / 2,
            camY + camHeight / 2,
            Math.min(newCamWidth, newCamHeight) / 2,
            0,
            2 * Math.PI
          );
          ctx.clip();
          ctx.drawImage(
            webcamPreview,
            camX + offsetX,
            camY + offsetY,
            newCamWidth,
            newCamHeight
          );
          ctx.restore();
        }

        animationFrameId = requestAnimationFrame(drawCanvas);
      }
    };

    drawCanvas();
    const canvasStream = canvas.captureStream(30);
    if (canvasStream.getVideoTracks().length === 0) {
      console.error("Canvas stream has no video tracks");
      setStartingRecording(false);
      return;
    }

    canvasStream
      .getVideoTracks()
      .forEach((track) => combinedStream.addTrack(track));

    videoStream
      .getAudioTracks()
      .forEach((track) => combinedStream.addTrack(track));

    const mimeTypes = [
      "video/webm;codecs=h264",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];

    let selectedMimeType = "";
    for (const mimeType of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        selectedMimeType = mimeType;
        break;
      }
    }

    if (!selectedMimeType) {
      toast.error("Sorry, your browser does not support screen recording :(");
      setStartingRecording(false);
      return;
    }

    const videoRecorderOptions = {
      mimeType: selectedMimeType,
    };

    if (!MediaRecorder.isTypeSupported(videoRecorderOptions.mimeType)) {
      console.error("Video MIME type not supported");
      setStartingRecording(false);
      return;
    }

    const videoRecorder = new MediaRecorder(
      combinedStream,
      videoRecorderOptions
    );

    const videoBitsPerSecond = videoRecorder.videoBitsPerSecond;

    const videoTracks = canvasStream.getVideoTracks();
    const frameRate = videoTracks[0].getSettings().frameRate || 30;

    const resolution = `${canvas.width}x${canvas.height}`;

    let segmentStartTime = 0;
    let segmentEndTime = 0;

    function recordVideoChunk() {
      videoRecorder.start();

      recordingIntervalRef.current = setInterval(() => {
        if (videoRecorder.state === "recording") videoRecorder.stop();

        if (videoRecorder) recordVideoChunk();
      }, 5000);
    }

    videoRecorder.onstart = () => {
      segmentStartTime = Date.now();
      segmentStartTimeRef.current = segmentStartTime;
    };

    videoRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        segmentEndTime = Date.now();
        const duration = (segmentEndTime - segmentStartTime) / 1000;

        console.log("Segment duration:", duration);

        muxQueue.enqueue(async () => {
          await muxSegment({
            data: event.data,
            bandwidth: videoBitsPerSecond,
            framerate: frameRate,
            resolution: resolution,
            videoCodec: "h264",
            audioCodec: "aac",
            duration: Number(duration.toFixed(3)),
          });
        });
      }
    };

    recordVideoChunk();

    setVideoRecorder(videoRecorder);

    setIsRecording(true);
    setStartingRecording(false);
  };

  const muxSegment = async ({
    data,
    bandwidth,
    framerate,
    resolution,
    videoCodec,
    audioCodec,
    duration,
  }: {
    data: Blob;
    bandwidth: number;
    framerate: number;
    resolution: string;
    videoCodec?: string;
    audioCodec?: string;
    duration?: number;
  }) => {
    return new Promise(async (resolve, reject) => {
      const segmentIndex = totalSegments.current;

      console.log("Muxing segment index: ", segmentIndex);
      console.log("---start-1");

      console.log("Start directory:", await ffmpegRef.current.listDir("./"));

      const videoSegment = new Blob([data], { type: "video/webm" });

      console.log("2");

      if (videoSegment) {
        console.log("Video segment found");

        console.log("3");

        const segmentIndexString = String(segmentIndex).padStart(3, "0");

        console.log("4");

        const videoFile = await fetchFile(URL.createObjectURL(videoSegment));
        ffmpegRef.current.writeFile(
          `video_segment_${segmentIndexString}.webm`,
          videoFile
        );

        console.log("5");

        const segmentPaths = {
          videoInput: `video_segment_${segmentIndexString}.webm`,
          videoOutput: `video_segment_${segmentIndexString}.ts`,
          audioOutput: `audio_segment_${segmentIndexString}.aac`,
        };

        console.log("6");

        const videoFFmpegCommand = [
          "-i",
          segmentPaths.videoInput,
          "-map",
          "0:v",
          "-c:v",
          "libx264",
          "-profile:v",
          "main",
          "-level",
          "3.1",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-f",
          "mpegts",
          segmentPaths.videoOutput,
        ];

        const audioFFmpegCommand = [
          "-i",
          segmentPaths.videoInput,
          "-map",
          "0:a",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-profile:a",
          "aac_low",
          "-f",
          "adts",
          segmentPaths.audioOutput,
        ];

        console.log("7-8");
        const videoFFmpegExec = await ffmpegRef.current.exec(
          videoFFmpegCommand
        );
        console.log("FFmpeg video exec:", videoFFmpegExec);

        const audioFFmpegExec = await ffmpegRef.current.exec(
          audioFFmpegCommand
        );
        console.log("FFmpeg audio exec:", audioFFmpegExec);

        const videoData = await ffmpegRef.current.readFile(
          segmentPaths.videoOutput
        );

        console.log("9");

        console.log("9-list directory:", await ffmpegRef.current.listDir("./"));

        const audioData = await ffmpegRef.current.readFile(
          segmentPaths.audioOutput
        );

        console.log("10");

        const segmentFilenames = {
          video: `video/video_recording_${segmentIndexString}.ts`,
          audio: `audio/audio_recording_${segmentIndexString}.aac`,
        };

        console.log("11");

        const videoId = await getLatestVideoId();

        console.log("12");

        console.log("Duration:", duration);

        try {
          await uploadSegment({
            file: videoData,
            filename: segmentFilenames.video,
            videoId,
            duration,
            resolution,
            framerate,
            bandwidth,
          });

          console.log("13");

          await uploadSegment({
            file: audioData,
            filename: segmentFilenames.audio,
            videoId,
            duration,
          });

          console.log("14");
        } catch (error) {
          console.error("Upload segment error:", error);
          reject(error);
          return;
        }

        console.log("15");

        console.log("End directory:", await ffmpegRef.current.listDir("./"));

        await ffmpegRef.current.deleteFile(segmentPaths.videoInput);
        await ffmpegRef.current.deleteFile(segmentPaths.videoOutput);
        await ffmpegRef.current.deleteFile(segmentPaths.audioOutput);

        console.log("16---end");
        resolve(void 0);
      } else {
        console.log("No video segment found");
        resolve(void 0);
      }

      totalSegments.current++;
    });
  };

  const uploadSegment = async ({
    file,
    filename,
    videoId,
    duration = 3,
    resolution,
    framerate,
    bandwidth,
    videoCodec,
    audioCodec,
  }: {
    file: Uint8Array | string;
    filename: string;
    videoId: string;
    duration?: number;
    resolution?: string;
    framerate?: number;
    bandwidth?: number;
    videoCodec?: string;
    audioCodec?: string;
  }) => {
    const formData = new FormData();
    formData.append("filename", filename);
    formData.append("videoId", videoId);
    formData.append("blobData", new Blob([file], { type: "video/mp2t" }));
    formData.append("duration", String(duration));
    formData.append("resolution", resolution || "");
    formData.append("framerate", String(framerate || 30));
    formData.append("bandwidth", String(bandwidth || 0));
    formData.append("videoCodec", videoCodec || "");
    formData.append("audioCodec", audioCodec || "");

    await fetch(`${process.env.NEXT_PUBLIC_URL}/api/upload/new`, {
      method: "POST",
      body: formData,
    });
  };

  const stopRecording = async () => {
    setStoppingRecording(true);

    if (videoRecorder) {
      videoRecorder.stop();
    }

    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
    }

    await muxQueue.waitForEmpty();

    const videoId = await getLatestVideoId();
    const url =
      process.env.NEXT_PUBLIC_ENVIRONMENT === "development"
        ? `${process.env.NEXT_PUBLIC_URL}/s/${videoId}`
        : `https://cap.link/${videoId}`;

    const audio = new Audio("/recording-end.mp3");
    await audio.play();

    window.open(url, "_blank");

    setIsRecording(false);
    setStoppingRecording(false);
  };

  const handleRndDragStop = (
    e: any,
    d: any,
    previewType: "webcam" | "screen"
  ) => {
    const videoContainer = document.querySelector(".video-container");
    const preview = document.getElementById(
      previewType === "webcam" ? "webcamPreview" : "screenPreview"
    );

    if (videoContainer && preview) {
      const containerRect = videoContainer.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();

      const containerCenterX = containerRect.left + containerRect.width / 2;
      const containerCenterY = containerRect.top + containerRect.height / 2;

      const previewCenterX = previewRect.left + previewRect.width / 2;
      const previewCenterY = previewRect.top + previewRect.height / 2;

      const thresholdX = 15;
      const thresholdY = 15;

      const videoContainerWidth = videoContainer.clientWidth;
      const videoContainerHeight = videoContainer.clientHeight;

      if (Math.abs(previewCenterX - containerCenterX) <= thresholdX) {
        if (previewType === "webcam") {
          setWebcamStyleSettings((prevSettings) => ({
            ...prevSettings,
            x: (videoContainerWidth - prevSettings.width) / 2,
          }));
        } else if (previewType === "screen") {
          setScreenStyleSettings((prevSettings) => ({
            ...prevSettings,
            x: (videoContainerWidth - prevSettings.width) / 2,
          }));
        }
      } else {
        if (previewType === "webcam") {
          setWebcamStyleSettings((prevSettings) => ({
            ...prevSettings,
            x: d.x,
          }));
        } else if (previewType === "screen") {
          setScreenStyleSettings((prevSettings) => ({
            ...prevSettings,
            x: d.x,
          }));
        }
      }

      if (Math.abs(previewCenterY - containerCenterY) <= thresholdY) {
        if (previewType === "webcam") {
          setWebcamStyleSettings((prevSettings) => ({
            ...prevSettings,
            y: (videoContainerHeight - prevSettings.height) / 2,
          }));
        } else if (previewType === "screen") {
          setScreenStyleSettings((prevSettings) => ({
            ...prevSettings,
            y: (videoContainerHeight - prevSettings.height) / 2,
          }));
        }

        setIsCenteredVertically(true);
      } else {
        if (previewType === "webcam") {
          setWebcamStyleSettings((prevSettings) => ({
            ...prevSettings,
            y: d.y,
          }));
        } else if (previewType === "screen") {
          setScreenStyleSettings((prevSettings) => ({
            ...prevSettings,
            y: d.y,
          }));
        }

        setIsCenteredVertically(false);
      }
    }
  };

  const handleRndDrag = (e: any, d: any, previewType: "webcam" | "screen") => {
    const videoContainer = document.querySelector(".video-container");
    const preview = document.getElementById(
      previewType === "webcam" ? "webcamPreview" : "screenPreview"
    );

    if (videoContainer && preview) {
      const containerRect = videoContainer.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();

      const containerCenterX = containerRect.left + containerRect.width / 2;
      const containerCenterY = containerRect.top + containerRect.height / 2;

      const previewCenterX = previewRect.left + previewRect.width / 2;
      const previewCenterY = previewRect.top + previewRect.height / 2;

      const thresholdX = 15;
      const thresholdY = 15;

      if (Math.abs(previewCenterY - containerCenterY) <= thresholdY) {
        setIsCenteredVertically(true);
      } else {
        setIsCenteredVertically(false);
      }

      if (Math.abs(previewCenterX - containerCenterX) <= thresholdX) {
        setIsCenteredHorizontally(true);
      } else {
        setIsCenteredHorizontally(false);
      }
    }
  };

  useEffect(() => {
    getDevices();
  }, []);

  useEffect(() => {
    const storedAudioDevice = localStorage.getItem("selectedAudioDevice");
    const storedVideoDevice = localStorage.getItem("selectedVideoDevice");
    const storedScreenStream = localStorage.getItem("screenStream");

    if (storedAudioDevice) {
      setSelectedAudioDevice(storedAudioDevice);
    }
    if (storedVideoDevice) {
      setSelectedVideoDevice(storedVideoDevice);
      startVideoCapture(storedVideoDevice, "large");
    }
    if (storedScreenStream === "true") {
      startScreenCapture();
    }
  }, []);

  useEffect(() => {
    if (selectedAudioDevice) {
      localStorage.setItem("selectedAudioDevice", selectedAudioDevice);
    } else {
      localStorage.removeItem("selectedAudioDevice");
    }
    if (selectedVideoDevice) {
      localStorage.setItem("selectedVideoDevice", selectedVideoDevice);
    } else {
      localStorage.removeItem("selectedVideoDevice");
    }
    if (screenStream) {
      localStorage.setItem("screenStream", "true");
    } else {
      localStorage.removeItem("screenStream");
    }
  }, [selectedAudioDevice, selectedVideoDevice, screenStream]);

  useEffect(() => {
    if (screenPreviewRef.current && screenStream) {
      screenPreviewRef.current.srcObject = screenStream;
    }
    if (webcamPreviewRef.current && videoStream) {
      webcamPreviewRef.current.srcObject = videoStream;
    }
  }, [screenStream, videoStream]);

  useEffect(() => {
    if (stoppingRecording) {
      const messages = ["Processing video", "Almost done", "Finishing up"];
      let messageIndex = 0;

      const nextMessage = () => {
        setCurrentStoppingMessage(messages[messageIndex % messages.length]);
        messageIndex++;
      };

      nextMessage();

      const intervalId = setInterval(nextMessage, 2500);

      return () => clearInterval(intervalId);
    } else {
      setCurrentStoppingMessage("");
    }
  }, [stoppingRecording]);

  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    if (isRecording && !startingRecording) {
      const startTime = Date.now();

      intervalId = setInterval(() => {
        const seconds = Math.floor((Date.now() - startTime) / 1000);
        const minutes = Math.floor(seconds / 60);
        const formattedSeconds =
          seconds % 60 < 10 ? `0${seconds % 60}` : seconds % 60;
        setRecordingTime(`${minutes}:${formattedSeconds}`);
      }, 1000);
    }

    return () => {
      clearInterval(intervalId);
      setRecordingTime("00:00");
    };
  }, [isRecording, startingRecording]);

  useEffect(() => {
    const storedAudioDevice = localStorage.getItem("selectedAudioDevice");
    const storedVideoDevice = localStorage.getItem("selectedVideoDevice");
    const storedScreenStream = localStorage.getItem("screenStream");

    if (storedAudioDevice) {
      setSelectedAudioDevice(storedAudioDevice);
      const selectedAudioDeviceObj = audioDevices.find(
        (device) => device.deviceId === storedAudioDevice
      );
      if (selectedAudioDeviceObj) {
        setSelectedAudioDeviceLabel(selectedAudioDeviceObj.label);
      }
    }
    if (storedVideoDevice) {
      setSelectedVideoDevice(storedVideoDevice);
      const selectedVideoDeviceObj = videoDevices.find(
        (device) => device.deviceId === storedVideoDevice
      );
      if (selectedVideoDeviceObj) {
        setSelectedVideoDeviceLabel(selectedVideoDeviceObj.label);
      }
      startVideoCapture(
        storedVideoDevice,
        screenStream === null ? "large" : "small"
      );
    }
    if (storedScreenStream === "true") {
      startScreenCapture();
    }
  }, [audioDevices, videoDevices]);

  if (isLoading) {
    return (
      <div className="w-full h-screen flex items-center justify-center">
        <LogoSpinner className="w-10 h-auto animate-spin" />
      </div>
    );
  }

  const screenHeight = window.innerHeight;
  const topBar = document.querySelector(".top-bar");
  const bottomBar = document.querySelector(".bottom-bar");
  const topBarHeight = topBar ? topBar.clientHeight : 0;
  const bottomBarHeight = bottomBar ? bottomBar.clientHeight : 0;
  const screenWidth = window.innerWidth;
  const maxWidth =
    document.querySelector(".wrapper")?.clientWidth || screenWidth;
  const calculatedHeight = maxWidth / aspectRatio;
  const availableHeight = Math.min(
    calculatedHeight,
    (screenHeight - topBarHeight - bottomBarHeight) * 0.8
  );

  return (
    <div className="w-full h-full min-h-screen h mx-auto flex items-center justify-center">
      <div className={`max-w-[1280px] wrapper p-8 space-y-6`}>
        <div className="top-bar flex justify-between">
          <a href="/" className="flex items-center">
            <ArrowLeft className="w-6 h-6 text-gray-600" />
          </a>
          <Button
            {...(isRecording && { variant: "destructive" })}
            onClick={() => {
              if (isRecording) {
                stopRecording();
              } else {
                startRecording();
              }
            }}
            spinner={startingRecording || stoppingRecording}
          >
            {startingRecording
              ? "Starting..."
              : isRecording
              ? stoppingRecording
                ? currentStoppingMessage
                : `Stop - ${recordingTime}`
              : "Start Recording"}
          </Button>
        </div>
        <div className="h-full flex-grow">
          <div className="w-full h-full top-0 left-0 h-full flex flex-col items-center justify-center">
            <div
              style={{
                aspectRatio: aspectRatio,
                height: availableHeight,
                maxWidth: "100%",
              }}
              className={`video-container bg-black relative w-auto mx-auto border-2 border-gray-200 rounded-xl overflow-hidden shadow-xl`}
            >
              {isCenteredHorizontally && (
                <div
                  className="crosshair absolute top-0 left-1/2 transform -translate-x-1/2 w-0.5 h-full bg-red-500"
                  style={{ zIndex: 999 }}
                ></div>
              )}
              {isCenteredVertically && (
                <div
                  className="crosshair absolute top-1/2 left-0 transform -translate-y-1/2 w-full h-0.5 bg-red-500"
                  style={{ zIndex: 999 }}
                ></div>
              )}
              {screenStream && (
                <Rnd
                  position={{
                    x: screenStyleSettings.x,
                    y: screenStyleSettings.y,
                  }}
                  size={{
                    width: screenStyleSettings.width,
                    height: screenStyleSettings.height,
                  }}
                  bounds="parent"
                  className="absolute rnd group"
                  resizeHandleStyles={defaultRndHandeStyles}
                  resizeHandleClasses={{
                    bottomRight: "resize-handle",
                    bottomLeft: "resize-handle",
                    bottom: "resize-handle",
                    right: "resize-handle",
                    left: "resize-handle",
                    top: "resize-handle",
                    topLeft: "resize-handle",
                    topRight: "resize-handle",
                  }}
                  onDrag={(e, d) => handleRndDrag(e, d, "screen")}
                  onDragStop={(e, d) => handleRndDragStop(e, d, "screen")}
                  onResizeStop={(e, direction, ref, delta, position) => {
                    setScreenStyleSettings({
                      ...screenStyleSettings,
                      width: ref.offsetWidth,
                      height: ref.offsetHeight,
                    });
                  }}
                >
                  <div className="w-full h-full group-hover:outline outline-2 outline-primary rounded-xl">
                    <video
                      id="screenPreview"
                      ref={screenPreviewRef}
                      autoPlay
                      muted
                      className="w-full h-full"
                    />
                  </div>
                </Rnd>
              )}
              {videoStream && (
                <Rnd
                  position={{
                    x: webcamStyleSettings.x,
                    y: webcamStyleSettings.y,
                  }}
                  size={{
                    width: webcamStyleSettings.width,
                    height: webcamStyleSettings.height,
                  }}
                  default={webcamStyleSettings}
                  bounds="parent"
                  className="absolute webcam-rnd rnd group"
                  lockAspectRatio={true}
                  resizeHandleStyles={defaultRndHandeStyles}
                  resizeHandleClasses={{
                    bottomRight: "resize-handle",
                    bottomLeft: "resize-handle",
                    bottom: "resize-handle",
                    right: "resize-handle",
                    left: "resize-handle",
                    top: "resize-handle",
                    topLeft: "resize-handle",
                    topRight: "resize-handle",
                  }}
                  onDrag={(e, d) => handleRndDrag(e, d, "webcam")}
                  onDragStop={(e, d) => handleRndDragStop(e, d, "webcam")}
                  onResizeStop={(e, direction, ref, delta, position) => {
                    setWebcamStyleSettings({
                      ...webcamStyleSettings,
                      width: ref.offsetWidth,
                      height: ref.offsetHeight,
                    });
                  }}
                >
                  <div className="w-full h-full rounded-xl overflow-hidden group-hover:outline outline-2 outline-primary">
                    <video
                      id="webcamPreview"
                      ref={webcamPreviewRef}
                      autoPlay
                      muted
                      className="w-full h-full object-cover"
                    />
                  </div>
                </Rnd>
              )}
            </div>
          </div>
        </div>
        <div>
          <div className="bottom-bar space-y-4 mb-4 w-full">
            <div className="space-x-3 flex items-center">
              <div className="w-full">
                <ActionButton
                  handler={() => {
                    screenStream ? stopScreenCapture() : startScreenCapture();
                  }}
                  icon={<Monitor className="w-5 h-5" />}
                  label={screenStream ? "Hide display" : "Select display"}
                  active={true}
                />
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger className="w-full">
                  <ActionButton
                    width="full"
                    icon={<Video className="w-5 h-5" />}
                    label={selectedVideoDeviceLabel}
                    active={true}
                    recordingOption={true}
                    optionName="Video"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56">
                  {videoDevices.map((device) => (
                    <DropdownMenuItem
                      key={device.deviceId}
                      onSelect={() => {
                        setSelectedVideoDevice(device.deviceId);
                        setSelectedVideoDeviceLabel(device.label);
                        startVideoCapture(device.deviceId);
                      }}
                    >
                      {device.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger className="w-full">
                  <ActionButton
                    width="full"
                    icon={<Mic className="w-5 h-5" />}
                    label={selectedAudioDeviceLabel}
                    active={true}
                    recordingOption={true}
                    optionName="Audio"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56">
                  {audioDevices.map((device) => (
                    <DropdownMenuItem
                      key={device.deviceId}
                      onSelect={() => {
                        setSelectedAudioDevice(device.deviceId);
                        setSelectedAudioDeviceLabel(device.label);
                        startVideoCapture(device.deviceId);
                      }}
                    >
                      {device.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
