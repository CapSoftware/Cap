"use client";

import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  useState,
  useEffect,
  useRef,
  type SetStateAction,
  type Dispatch,
  useMemo,
} from "react";
import { Store } from "@tanstack/store";
import { useStore } from "@tanstack/react-store";

import type { users } from "@cap/database/schema";
import { Mic, Video, Monitor, ArrowLeft } from "lucide-react";
import { type DraggableData, Rnd } from "react-rnd";
import type { DraggableEvent } from "react-draggable";
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
import { isUserOnProPlan } from "@cap/utils";
import { LogoBadge } from "@cap/ui";
import { set } from "lodash";
import { AudioDefaultSelection } from "@aws-sdk/client-mediaconvert";
import type { FileData } from "@ffmpeg/ffmpeg/dist/esm/types";

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

const devicesQuery = queryOptions({
  queryKey: ["devices"],
  queryFn: async () => {
    try {
      await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      const devices = await navigator.mediaDevices.enumerateDevices();

      return {
        audio: devices.filter((device) => device.kind === "audioinput"),
        video: devices.filter((device) => device.kind === "videoinput"),
      };
    } catch (error) {
      console.error("Error accessing media devices:", error);
    }

    return { audio: [], video: [] };
  },
  initialData: { audio: [], video: [] },
});

type State<T> = ReturnType<typeof useState<T>>;

type FullStore = RecorderStore | { status: "idle" } | { status: "starting" };

// million-ignore
export const Record = ({
  user,
}: {
  user: typeof users.$inferSelect | null;
}) => {
  const [ffmpeg] = useState(() => new FFmpeg());
  const [isLoading, setIsLoading] = useState(true);

  const devices = useQuery(devicesQuery).data;
  const [audioDeviceId, setAudioDeviceId] = useState<string>();
  const [videoDeviceId, setVideoDeviceId] = useState<string>();
  const audioDevice = devices.audio.find((d) => d.deviceId === audioDeviceId);
  const videoDevice = devices.video.find((d) => d.deviceId === videoDeviceId);

  const screenPreviewRef = useRef<HTMLVideoElement>(null);
  const webcamPreviewRef = useRef<HTMLVideoElement>(null);

  const [screenStream, setScreenStream] = interceptSetter(
    useState<MediaStream | null>(null),
    (value) => {
      if (screenPreviewRef.current) screenPreviewRef.current.srcObject = value;
    }
  );
  const [videoStream, setVideoStream] = interceptSetter(
    useState<MediaStream | null>(null),
    (stream) => {
      if (webcamPreviewRef.current) webcamPreviewRef.current.srcObject = stream;
    }
  );

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
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const store = useMemo(() => {
    recorder;
    return new Store<FullStore>({ status: "idle" });
  }, [recorder]);

  const state = useStore(
    (recorder?.store as Store<FullStore> | undefined) ?? store
  );

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

  const startScreenCapture = async () => {
    try {
      const displayMediaOptions = {
        audio: false,
        surfaceSwitching: "exclude",
        selfBrowserSurface: "exclude",
        systemAudio: "exclude",
      };

      const stream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaOptions
      );
      if (stream)
        for (const track of stream.getTracks()) {
          track.onended = async () => {
            if (recorder) await recorder.stop();
          };
        }

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
          if (videoDeviceId !== undefined) {
            startVideoCapture(videoDeviceId, "small");
          }
          resolve({ width: videoWidth, height: videoHeight });
        };
      });
    } catch (error) {
      console.error("Error capturing screen:", error);
    }
  };

  const startVideoCapture = async (
    deviceId?: string,
    microphoneId?: string,
    placement?: "small" | "large"
  ) => {
    try {
      const constraints: MediaStreamConstraints = {
        video: deviceId
          ? { deviceId, width: { ideal: 1920 }, height: { ideal: 1080 } }
          : { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: microphoneId
          ? { deviceId: microphoneId }
          : audioDeviceId
          ? { deviceId: audioDeviceId }
          : false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log("deviceId: ", deviceId);
      console.log("finding video devices: ", devices.video);
      console.log("found: ", videoDevice);
      setVideoStream(stream);

      const videoContainer = document.querySelector(
        ".video-container"
      ) as HTMLElement;

      if (videoContainer === null) {
        console.error("Video container dimensions not found");
        setTimeout(startVideoCapture, 1000);
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
      stopVideoCapture();
    }
  };

  const stopVideoCapture = () => {
    if (videoStream) {
      videoStream.getTracks().forEach((track) => track.stop());
      setVideoStream(null);
    }
  };

  const makeOnRndDragStop =
    (previewType: "webcam" | "screen") =>
    (_e: DraggableEvent, d: DraggableData) => {
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

          setIsCenteredHorizontally(true);
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

          setIsCenteredHorizontally(false);
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

  const makeOnRndDrag =
    (previewType: "webcam" | "screen") =>
    (/* e : DraggableEvent, d: DraggableData */) => {
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

  useLocalStoragePersist("selectedAudioDevice", audioDeviceId);
  useLocalStoragePersist("selectedVideoDevice", videoDeviceId);
  useLocalStoragePersist("screenStream", screenStream ? "true" : undefined);

  const seconds = state.status === "recording" ? state.seconds : 0;

  const recordingTime = useMemo(() => {
    const minutes = Math.floor(seconds / 60);
    const formattedSeconds =
      seconds % 60 < 10 ? `0${seconds % 60}` : seconds % 60;
    return `${minutes}:${formattedSeconds}`;
  }, [seconds]);

  useEffect(() => {
    const storedAudioDevice = localStorage.getItem("selectedAudioDevice");
    const storedVideoDevice = localStorage.getItem("selectedVideoDevice");
    const storedScreenStream = localStorage.getItem("screenStream");

    if (storedAudioDevice) setAudioDeviceId(storedAudioDevice);
    if (storedVideoDevice) setVideoDeviceId(storedVideoDevice);

    startVideoCapture(
      storedVideoDevice ?? undefined,
      storedAudioDevice ?? undefined,
      screenStream === null ? "large" : "small"
    );
    if (storedScreenStream === "true") startScreenCapture();
  }, [devices]);

  // useEffect(() => {
  //   const audio = new Audio("/sample-9s.mp3");
  //   audio.loop = true;
  //   audio.volume = 1;

  //   const playAudio = () => {
  //     audio.play();
  //     window.removeEventListener("mousemove", playAudio);
  //   };

  //   window.addEventListener("mousemove", playAudio);

  //   return () => {
  //     window.removeEventListener("mousemove", playAudio);
  //   };
  // }, []);
  if (isLoading) {
    return (
      <div className="w-full h-screen flex items-center justify-center">
        <LogoSpinner className="w-10 h-auto animate-spin" />
      </div>
    );
  }

  return (
    <div className="w-full h-full min-h-screen h mx-auto flex items-center justify-center">
      <div className="max-w-[1280px] wrapper p-8 space-y-6">
        {isSafari && (
          <div className="bg-red-500 py-3 rounded-xl">
            <div className="wrapper">
              <p className="text-white text-lg font-medium">
                Currently experiencing some intermitent problems with Safari
                browser. Fix is in progress.
              </p>
            </div>
          </div>
        )}
        <div className="top-bar grid grid-cols-12 justify-between">
          <div className="col-span-4 flex items-center justify-start">
            <a href="/dashboard" className="flex items-center">
              <ArrowLeft className="w-7 h-7 text-gray-600" />
              <LogoBadge className="w-8 h-auto ml-2" />
            </a>
          </div>
          <div className="col-span-4 flex items-center justify-center">
            {isUserOnProPlan({
              subscriptionStatus: user?.stripeSubscriptionStatus as string,
            }) ? (
              <p className="text-sm text-gray-600">No recording limit</p>
            ) : (
              <div>
                <p className="text-sm text-gray-600">5 min recording limit</p>
                <a
                  href="/pricing"
                  className="text-sm text-primary font-medium hover:underline"
                >
                  Upgrade to Cap Pro
                </a>
              </div>
            )}
          </div>
          <div className="col-span-4 flex items-center justify-end">
            <Button
              className="min-w-[175px]"
              {...(state?.status === "recording" && {
                variant: "destructive",
              })}
              onClick={async () => {
                if (recorder !== null) await recorder.stop();
                else if (state.status === "idle") {
                  if (!screenStream) {
                    toast.error(
                      "No screen capture source selected, plesae select a screen source."
                    );
                    store.setState(() => ({ status: "idle" }));
                    return;
                  }

                  store.setState(() => ({ status: "starting" }));

                  createRecorder(videoDevice, videoStream, audioDevice, ffmpeg)
                    .then((recorder) => {
                      setRecorder(recorder);
                    })
                    .catch((e) => {
                      console.error(e);
                      store.setState(() => ({ status: "idle" }));
                    });
                }
              }}
              spinner={
                state.status === "starting" || state.status === "stopping"
              }
            >
              {state.status === "idle"
                ? "Start Recording"
                : state.status === "starting"
                ? "Starting..."
                : state.status === "recording"
                ? `Stop - ${recordingTime}`
                : state.message}
            </Button>
          </div>
        </div>
        <div className="h-full flex-grow">
          <div className="w-full h-full top-0 left-0 h-full flex flex-col items-center justify-center">
            <div
              style={{
                aspectRatio: aspectRatio,
                maxWidth: "100%",
              }}
              className="video-container bg-black relative w-full mx-auto border-2 border-gray-200 rounded-xl overflow-hidden shadow-xl"
            >
              {!screenStream && (
                <div
                  className="absolute top-1/2 left-1/2 -translate-y-1/2 -translate-x-1/2 w-full h-full flex items-center justify-center"
                  style={{ zIndex: 999 }}
                >
                  <div className="wrapper w-full text-center space-y-2">
                    <p className="text-2xl text-white">
                      Select a screen or window source to get started.
                    </p>
                    <p className="text-xl text-white">
                      Once selected, click the "Start Recording" button to
                      begin.
                    </p>
                  </div>
                </div>
              )}
              {isCenteredHorizontally && (
                <div
                  className="crosshair absolute top-0 left-1/2 transform -translate-x-1/2 w-0.5 h-full bg-red-500"
                  style={{ zIndex: 999 }}
                />
              )}
              {isCenteredVertically && (
                <div
                  className="crosshair absolute top-1/2 left-0 transform -translate-y-1/2 w-full h-0.5 bg-red-500"
                  style={{ zIndex: 999 }}
                />
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
                  onDrag={makeOnRndDrag("screen")}
                  onDragStop={makeOnRndDragStop("screen")}
                  onResizeStop={(e, direction, ref, delta, position) => {
                    setScreenStyleSettings({
                      width: ref.offsetWidth,
                      height: ref.offsetHeight,
                      x: position.x,
                      y: position.y,
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
              {videoStream && videoDevice !== undefined && (
                <Rnd
                  id="rndPreview"
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
                  className="absolute webcam-rnd rnd group hover:outline outline-2 outline-primary"
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
                  onDrag={makeOnRndDrag("webcam")}
                  onDragStop={makeOnRndDragStop("webcam")}
                  onResizeStop={(e, direction, ref, delta, position) => {
                    setWebcamStyleSettings({
                      width: ref.offsetWidth,
                      height: ref.offsetHeight,
                      x: position.x,
                      y: position.y,
                    });
                  }}
                >
                  <div className="w-full h-full rounded-full overflow-hidden group-hover:outline outline-2 outline-primary">
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
                <p className="text-left text-sm font-semibold">
                  Screen / Window
                </p>
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
                  <p className="text-left text-sm font-semibold">Webcam</p>
                  <ActionButton
                    width="full"
                    icon={<Video className="w-5 h-5" />}
                    label={videoDevice?.label ?? "None"}
                    active={true}
                    recordingOption={true}
                    optionName="Video"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56">
                  {devices.video.map((device) => (
                    <DropdownMenuItem
                      key={device.deviceId}
                      onSelect={() => {
                        setVideoDeviceId(device.deviceId);
                        startVideoCapture(
                          device.deviceId,
                          audioDeviceId,
                          "small"
                        );
                      }}
                    >
                      {device.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem
                    onSelect={() => {
                      setVideoDeviceId(undefined);
                      stopVideoCapture();
                    }}
                  >
                    None
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger className="w-full">
                  <p className="text-left text-sm font-semibold">Microphone</p>
                  <ActionButton
                    width="full"
                    icon={<Mic className="w-5 h-5" />}
                    label={audioDevice?.label ?? "None"}
                    active={true}
                    recordingOption={true}
                    optionName="Audio"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56">
                  {devices.audio.map((device) => (
                    <DropdownMenuItem
                      key={device.deviceId}
                      onSelect={() => {
                        setAudioDeviceId(device.deviceId);
                        startVideoCapture(
                          videoDeviceId,
                          device.deviceId,
                          "small"
                        );
                      }}
                    >
                      {device.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem
                    onSelect={() => {
                      setAudioDeviceId(undefined);
                    }}
                  >
                    None
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const uploadSegment = async ({
  file,
  filename,
  videoId,
  duration,
}: {
  file: Uint8Array | string;
  filename: string;
  videoId: string;
  duration?: string;
}) => {
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
};

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
  ffmpeg: FFmpeg
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

  const videoContainer = document.querySelector(
    ".video-container"
  ) as HTMLElement;
  const screenPreview = document.getElementById(
    "screenPreview"
  ) as HTMLVideoElement;
  const webcamPreview = document.getElementById(
    "webcamPreview"
  ) as HTMLVideoElement;

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

type Recorder = Awaited<ReturnType<typeof createRecorder>>;
type RecorderStore =
  | { status: "recording"; seconds: number }
  | { status: "stopping"; message: string };

const STOPPING_MESSAGES = ["Processing video", "Almost done", "Finishing up"];

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

function useLocalStoragePersist(key: string, value?: string) {
  useEffect(() => {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  }, [key, value]);
}

function interceptSetter<S extends State<any>>(
  [get, _set]: S,
  _cb: (
    v: S extends [infer T, Dispatch<SetStateAction<any>>] ? T : never
  ) => void
) {
  const cbRef = useRef(_cb);
  cbRef.current = _cb;

  const { current: set } = useRef<typeof _set>((action) => {
    _set((prev: any) => {
      if (typeof action === "function") {
        const ret = action(prev);
        cbRef.current(ret);
        return ret;
      }

      cbRef.current(action);
      return action;
    });
  });

  return [get, set] as S;
}
