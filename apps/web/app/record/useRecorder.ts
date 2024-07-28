"use client";

import { getLatestVideoId, saveLatestVideoId } from "@cap/utils";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { FileData } from "@ffmpeg/ffmpeg/dist/esm/types";
import { fetchFile } from "@ffmpeg/util";
import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";

const STOPPING_MESSAGES = ["Processing video", "Almost done", "Finishing up"];

async function uploadSegment({
  file,
  filename,
  videoId,
  duration,
}: {
  file: Uint8Array | string;
  filename: string;
  videoId: string;
  duration?: string;
}) {
  const formData = new FormData();
  formData.append("filename", filename);
  formData.append("videoId", videoId);

  let mimeType = "video/mp2t";
  if (filename.endsWith(".aac")) {
    mimeType = "audio/aac";
  } else if (filename.endsWith(".jpg")) {
    mimeType = "image/jpeg";
  }
  formData.append("blobData", new Blob([file], { type: mimeType }));

  if (duration) formData.append("duration", String(duration));
  if (filename.includes("video")) formData.append("framerate", "30");

  await fetch(`${process.env.NEXT_PUBLIC_URL}/api/upload/new`, {
    method: "POST",
    body: formData,
  });
}

async function muxSegment({
  data,
  mimeType,
  start,
  end,
  segmentTime,
  segmentIndex,
  ffmpeg,
  hasAudio,
}: {
  data: Blob[];
  mimeType: string;
  start: number;
  end: number;
  segmentTime: number;
  segmentIndex: number;
  ffmpeg: FFmpeg;
  hasAudio: boolean;
}) {
  console.log("Muxing segment");

  const segmentIndexString = String(segmentIndex).padStart(3, "0");
  const videoSegment = new Blob(data, { type: "video/webm" });
  const segmentPaths = {
    tempInput: `temp_segment_${segmentIndexString}${
      mimeType.includes("mp4") ? ".mp4" : ".webm"
    }`,
    videoInput: `input_segment_${segmentIndexString}.ts`,
    videoOutput: `video_segment_${segmentIndexString}.ts`,
    audioOutput: `audio_segment_${segmentIndexString}.aac`,
  };

  if (videoSegment) {
    const videoFile = await fetchFile(URL.createObjectURL(videoSegment));

    await ffmpeg.writeFile(segmentPaths.tempInput, videoFile);

    const tempVideoCommand = [
      "-ss",
      start.toFixed(2),
      "-to",
      end.toFixed(2),
      "-i",
      segmentPaths.tempInput,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-c:a",
      "aac",
      "-f",
      "hls",
      segmentPaths.videoInput,
    ];

    try {
      await ffmpeg.exec(tempVideoCommand);
    } catch (error) {
      console.error("Error executing tempVideoCommand with FFmpeg:", error);
      throw error;
    }

    const videoFFmpegCommand = [
      ["-i", segmentPaths.videoInput, "-map", "0:v"],
      ["-c:v", "libx264", "-preset", "ultrafast"],
      ["-pix_fmt", "yuv420p", "-r", "30"],
      [segmentPaths.videoOutput],
    ].flat();

    try {
      await ffmpeg.exec(videoFFmpegCommand);
    } catch (error) {
      console.error("Error executing videoFFmpegCommand with FFmpeg:", error);
      throw error;
    }

    if (hasAudio) {
      console.log("Muxing audio");
      const audioFFmpegCommand = [
        ["-i", segmentPaths.videoInput],
        ["-map", "0:a", "-c:a", "aac"],
        ["-b:a", "128k", "-profile:a", "aac_low"],
        [segmentPaths.audioOutput],
      ].flat();
      try {
        await ffmpeg.exec(audioFFmpegCommand);
        console.log("hereaudioexecuted: ", await ffmpeg.listDir("/"));
      } catch (error) {
        console.error("Error executing audioFFmpegCommand with FFmpeg:", error);
        console.log("audio error here: ", await ffmpeg.listDir("/"));
        throw error;
      }
    }

    let videoData: FileData | undefined;
    try {
      videoData = await ffmpeg.readFile(segmentPaths.videoOutput);
      console.log("file list: ", await ffmpeg.listDir("/"));
    } catch (error) {
      console.error("Error reading video file with FFmpeg:", error);
      throw error;
    }

    let audioData: FileData | undefined;
    if (hasAudio) {
      try {
        audioData = await ffmpeg.readFile(segmentPaths.audioOutput);

        console.log("Found audio data:", audioData);
      } catch (error) {
        console.error("Error reading audio file with FFmpeg:", error);
        console.log("audio error here: ", await ffmpeg.listDir("/"));
        throw error;
      }
    }

    const segmentFilenames = {
      video: `video/video_recording_${segmentIndexString}.ts`,
      audio: `audio/audio_recording_${segmentIndexString}.aac`,
    };

    const videoId = await getLatestVideoId();

    if (segmentIndex === 0) {
      console.log("Generating screenshot...");
      const video = document.createElement("video");
      video.src = URL.createObjectURL(videoSegment);
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;

      video.addEventListener("loadeddata", async () => {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const context = canvas.getContext("2d");
        context?.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);

        canvas.toBlob(
          async (screenshotBlob) => {
            if (screenshotBlob) {
              const screenshotFile = await fetchFile(
                URL.createObjectURL(screenshotBlob)
              );

              const screenshotFilename = "screenshot/screen-capture.jpg";
              await uploadSegment({
                file: screenshotFile,
                filename: screenshotFilename,
                videoId,
              });
            }
          },
          "image/jpeg",
          0.5
        );
        video.remove();
        canvas.remove();
      });

      video.play().catch((error) => {
        console.error("Video play failed:", error);
      });
    }

    try {
      await uploadSegment({
        file: videoData,
        filename: segmentFilenames.video,
        videoId,
        duration: segmentTime.toFixed(1),
      });

      if (audioData) {
        await uploadSegment({
          file: audioData,
          filename: segmentFilenames.audio,
          videoId,
          duration: segmentTime.toFixed(1),
        });
      }
    } catch (error) {
      console.error("Upload segment error:", error);
      throw error;
    }

    console.log("herelast: ", await ffmpeg.listDir("/"));

    try {
      await ffmpeg.deleteFile(segmentPaths.tempInput);
    } catch (error) {
      console.error("Error deleting temp input file:", error);
    }

    try {
      await ffmpeg.deleteFile(segmentPaths.videoInput);
    } catch (error) {
      console.error("Error deleting video input file:", error);
    }

    try {
      await ffmpeg.deleteFile(segmentPaths.videoOutput);
    } catch (error) {
      console.error("Error deleting video output file:", error);
    }

    if (audioData) {
      try {
        await ffmpeg.deleteFile(segmentPaths.audioOutput);
      } catch (error) {
        console.error("Error deleting audio output file:", error);
      }
    }
  }
}

async function createRecorder(
  videoDevice: MediaDeviceInfo | undefined,
  videoStream: MediaStream | null,
  audioDevice: MediaDeviceInfo | undefined,
  ffmpeg: FFmpeg,
  videoContainer: HTMLElement,
  screenPreview?: HTMLVideoElement,
  webcamPreview?: HTMLVideoElement
) {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_URL}/api/desktop/video/create`,
    {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    }
  );

  if (res.status === 401) {
    toast.error("Unauthorized - please sign in again.");
    throw "Unauthorized";
  }

  const videoCreateData = await res.json();

  if (
    !videoCreateData.id ||
    !videoCreateData.user_id ||
    !videoCreateData.aws_region ||
    !videoCreateData.aws_bucket
  ) {
    toast.error("No data received - please try again later.");
    throw "No data received";
  }

  saveLatestVideoId(videoCreateData.id);

  const combinedStream = new MediaStream();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let screenX: number,
    screenY: number,
    screenWidth: number,
    screenHeight: number;
  let webcamX: number,
    webcamY: number,
    webcamWidth: number,
    webcamHeight: number;
  let newWebcamWidth: number,
    newWebcamHeight: number,
    offsetX: number,
    offsetY: number;

  // Set canvas dimensions to video container dimensions
  canvas.width = videoContainer.clientWidth;
  canvas.height = videoContainer.clientHeight;

  // Calculate coordinates and dimensions once
  if (screenPreview && videoContainer) {
    const screenRect = screenPreview.getBoundingClientRect();
    const containerRect = videoContainer.getBoundingClientRect();

    screenX =
      (screenRect.left - containerRect.left) *
      (canvas.width / containerRect.width);
    screenY =
      (screenRect.top - containerRect.top) *
      (canvas.height / containerRect.height);
    screenWidth = screenRect.width * (canvas.width / containerRect.width);
    screenHeight = screenRect.height * (canvas.height / containerRect.height);
  }

  if (webcamPreview && videoContainer && videoDevice) {
    const webcamRect = webcamPreview.getBoundingClientRect();
    const containerRect = videoContainer.getBoundingClientRect();

    webcamX =
      (webcamRect.left - containerRect.left) *
      (canvas.width / containerRect.width);
    webcamY =
      (webcamRect.top - containerRect.top) *
      (canvas.height / containerRect.height);
    webcamWidth = webcamRect.width * (canvas.width / containerRect.width);
    webcamHeight = webcamRect.height * (canvas.height / containerRect.height);

    const videoAspectRatio =
      webcamPreview.videoWidth / webcamPreview.videoHeight;
    newWebcamWidth = webcamWidth * 2;
    newWebcamHeight = newWebcamWidth / videoAspectRatio;
    offsetX = (newWebcamWidth - webcamWidth) / 2;
    offsetY = (newWebcamHeight - webcamHeight) / 2;
  }

  const drawCanvas = () => {
    if (ctx && screenPreview && videoContainer) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(screenPreview, screenX, screenY, screenWidth, screenHeight);

      if (webcamPreview && videoContainer && videoDevice) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(
          webcamX + webcamWidth / 2,
          webcamY + webcamHeight / 2,
          webcamWidth / 2,
          0,
          2 * Math.PI
        );
        ctx.clip();
        ctx.drawImage(
          webcamPreview,
          webcamX - offsetX,
          webcamY - offsetY,
          newWebcamWidth,
          newWebcamHeight
        );
        ctx.restore();
      }
    }
  };

  const startDrawing = () => {
    const drawLoop = () => {
      drawCanvas();
      animationFrameId = requestAnimationFrame(drawLoop);
    };
    drawLoop();
    return animationFrameId;
  };

  const intervalDrawing = () => setInterval(drawCanvas, 1000 / 30); // 30 fps

  // Start drawing on canvas using requestAnimationFrame
  let animationFrameId = 0;
  animationFrameId = startDrawing();
  let animationIntervalId: number | NodeJS.Timeout | null = null;

  // Fallback to setInterval if the tab is not active
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(animationFrameId);
      animationIntervalId = intervalDrawing();
    } else {
      if (animationIntervalId) {
        clearInterval(animationIntervalId);
        animationIntervalId = null;
      }
      animationFrameId = startDrawing();
    }
  });

  const canvasStream = canvas.captureStream(30);
  if (canvasStream.getVideoTracks().length === 0) {
    throw "Canvas stream has no video tracks";
  }

  for (const track of canvasStream.getVideoTracks()) {
    combinedStream.addTrack(track);
  }

  if (videoStream && videoDevice) {
    for (const track of videoStream.getAudioTracks()) {
      combinedStream.addTrack(track);
    }
  }

  const mimeTypes = [
    "video/webm;codecs=h264",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
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
    throw "No supported MIME type found for screen recording";
  }

  const videoRecorderOptions = {
    mimeType: selectedMimeType,
  };

  if (!MediaRecorder.isTypeSupported(videoRecorderOptions.mimeType)) {
    throw "Video MIME type not supported";
  }

  const videoRecorder = new MediaRecorder(combinedStream, videoRecorderOptions);

  const chunks: Blob[] = [];
  let segmentStartTime = Date.now();
  const recordingStartTime = Date.now();

  // public stuff for UI to use
  const store = new Store<RecorderStore>({
    status: "recording",
    seconds: 0,
  });

  const startTime = Date.now();
  const secondsInterval = setInterval(() => {
    const seconds = Math.floor((Date.now() - startTime) / 1000);
    store.setState(() => ({ status: "recording", seconds }));
  }, 1000);

  let totalSegments = 0;
  let onReadyToStopRecording!: () => void;
  const readyToStopRecording = new Promise<void>((resolve) => {
    onReadyToStopRecording = resolve;
  });

  const muxQueue = new AsyncTaskQueue();

  videoRecorder.ondataavailable = async (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
      const segmentEndTime = Date.now();
      const segmentDuration = (segmentEndTime - segmentStartTime) / 1000.0;

      const videoDuration = (Date.now() - recordingStartTime) / 1000.0;

      console.log("Video duration:", videoDuration);
      console.log("Segment duration:", segmentDuration);
      console.log("Start:", Math.max(videoDuration - segmentDuration, 0));

      const final =
        videoRecorder.state !== "recording" ||
        store.state.status === "stopping";
      console.log("Final segment? ", final);

      muxQueue.enqueue(async () => {
        try {
          await muxSegment({
            data: chunks,
            mimeType: videoRecorderOptions.mimeType,
            start: Math.max(videoDuration - segmentDuration, 0),
            end: videoDuration,
            segmentTime: segmentDuration,
            segmentIndex: totalSegments,
            hasAudio: videoStream !== null && audioDevice !== undefined,
            ffmpeg,
          });

          totalSegments++;
          if (final) onReadyToStopRecording();
        } catch (error) {
          console.error("Error in muxSegment:", error);
          onReadyToStopRecording();
        }
      });

      segmentStartTime = segmentEndTime;
    }
  };

  videoRecorder.start(3000);

  return {
    store,
    videoRecorder,
    stop: async () => {
      if (store.state.status !== "recording") return;

      let messageIndex = 0;

      const nextMessage = () => {
        store.setState(() => ({
          status: "stopping",
          message: STOPPING_MESSAGES[messageIndex % STOPPING_MESSAGES.length],
        }));
        messageIndex++;
      };

      nextMessage();

      const messageInterval = setInterval(nextMessage, 2000);
      clearInterval(secondsInterval);

      console.log("---Stopping recording function fired here---");

      try {
        videoRecorder.stop();
        console.log("Video recorder stopped");

        await readyToStopRecording;

        await muxQueue.waitForQueueEmpty();

        console.log("All segments muxed");

        const videoId = await getLatestVideoId();

        console.log("---Opening link here---");

        const url =
          process.env.NEXT_PUBLIC_ENVIRONMENT === "development"
            ? `${process.env.NEXT_PUBLIC_URL}/s/${videoId}`
            : `https://cap.link/${videoId}`;

        const audio = new Audio("/recording-end.mp3");
        await audio.play();
        window.open(url, "_blank");
      } finally {
        clearInterval(messageInterval);
      }
    },
  };
}

export function useRecorder() {
  const [ffmpeg] = useState(() => new FFmpeg());
  const [isLoading, setIsLoading] = useState(true);
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  useEffect(() => {
    const loadFFmpeg = async () => {
      setIsLoading(true);

      console.log("Loading FFmpeg");

      await ffmpeg.load.call(ffmpeg);
      setIsLoading(false);

      console.log("FFmpeg loaded");
    };

    loadFFmpeg();
  }, [ffmpeg]);

  const store = useMemo(() => {
    recorder;
    return new Store<FullStore>({ status: "idle" });
  }, [recorder]);

  const state = useStore(
    (recorder?.store as Store<FullStore> | undefined) ?? store
  );

  return {
    state,
    isLoading,
    start(
      videoDevice: MediaDeviceInfo | undefined,
      videoStream: MediaStream | null,
      audioDevice: MediaDeviceInfo | undefined,
      videoContainer: HTMLElement,
      screenPreview?: HTMLVideoElement,
      webcamPreview?: HTMLVideoElement
    ) {
      if (!screen) {
        toast.error(
          "No screen capture source selected, plesae select a screen source."
        );
        return;
      }

      store.setState(() => ({ status: "starting" }));

      createRecorder(
        videoDevice,
        videoStream,
        audioDevice,
        ffmpeg,
        videoContainer,
        screenPreview,
        webcamPreview
      )
        .then((recorder) => {
          setRecorder(recorder);
        })
        .catch((e) => {
          console.error(e);
          store.setState(() => ({ status: "idle" }));
        });
    },
    stop() {
      recorderRef.current?.stop().finally(() => {
        setRecorder(null);
      });
    },
  };
}

export type Recorder = Awaited<ReturnType<typeof createRecorder>>;
export type RecorderStore =
  | { status: "recording"; seconds: number }
  | { status: "stopping"; message: string };
type FullStore = RecorderStore | { status: "idle" } | { status: "starting" };

class AsyncTaskQueue {
  private queue: (() => Promise<void>)[];
  private activeTasks: number;
  private resolveEmptyPromise: (() => void) | null;

  constructor() {
    this.queue = [];
    this.activeTasks = 0;
    this.resolveEmptyPromise = null;
  }

  public enqueue(task: () => Promise<void>) {
    this.queue.push(task);
    this.processQueue(); // Call processQueue whenever a new task is enqueued
  }

  private async processQueue() {
    if (this.activeTasks >= 1 || this.queue.length === 0) {
      return; // Don't start processing if there are already active tasks or the queue is empty
    }

    const task = this.queue.shift();
    if (task) {
      this.activeTasks++;
      try {
        await task();
      } finally {
        this.activeTasks--;
        if (this.activeTasks === 0 && this.resolveEmptyPromise) {
          this.resolveEmptyPromise();
          this.resolveEmptyPromise = null;
        }
        this.processQueue();
      }
    }
  }

  public waitForQueueEmpty(): Promise<void> {
    if (this.activeTasks === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.resolveEmptyPromise = resolve;
    });
  }
}
