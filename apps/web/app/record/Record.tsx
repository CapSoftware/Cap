"use client";

import {
  keepPreviousData,
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  type ComponentProps,
  type RefObject,
} from "react";
import { isUserOnProPlan } from "@cap/utils";
import { LogoBadge } from "@cap/ui";
import type { users } from "@cap/database/schema";
import { Mic, Video, Monitor, ArrowLeft } from "lucide-react";
import { type HandleClasses, Rnd } from "react-rnd";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  LogoSpinner,
} from "@cap/ui";

import { ActionButton } from "./_components/ActionButton";
import { useRecorder } from "./useRecorder";
import { flushSync } from "react-dom";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      gcTime: 0,
    },
  },
});

export function Record({ user }: { user: typeof users.$inferSelect | null }) {
  return (
    <QueryClientProvider client={client}>
      <Component user={user} />
    </QueryClientProvider>
  );
}

const CENTERED_THRESHOLD = 15;

// million-ignore
const Component = ({ user }: { user: typeof users.$inferSelect | null }) => {
  const devices = useQuery(devicesQuery).data;
  const [audioDeviceId, setAudioDeviceId] = useState<string>();
  const [webcamDeviceId, setWebcamDeviceId] = useState<string>();
  const audioDevice = devices.audio.find((d) => d.deviceId === audioDeviceId);
  const webcamDevice = devices.video.find((d) => d.deviceId === webcamDeviceId);

  const screenPreviewRef = useRef<HTMLVideoElement>(null);
  const webcamPreviewRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);

  const showScreen = useRef(false);
  const screen = useQuery({
    queryKey: ["screen"],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      if (screen.data)
        for (const track of screen.data.stream.getTracks()) {
          track.stop();
        }

      if (!showScreen.current) return null;

      const result = await getScreenStream();
      if (!result) return null;

      for (const track of result.stream.getTracks()) {
        track.onended = () => recorder.stop();
      }

      return result;
    },
  });

  const webcamStream = useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      "webcamStream",
      {
        deviceId: webcamDeviceId,
        microphoneId: audioDeviceId,
        skip: screen.data === null,
      },
    ] as const,
    queryFn: async ({ queryKey: [_, { deviceId, microphoneId, skip }] }) => {
      if (webcamStream.data)
        for (const track of webcamStream.data.getTracks()) {
          track.stop();
        }

      if (skip) return null;

      const stream = await getWebcamStream({ deviceId, microphoneId });
      if (!stream) return null;

      return stream;
    },
  });

  useEffect(() => {
    if (screenPreviewRef.current)
      screenPreviewRef.current.srcObject = screen.data?.stream ?? null;
    if (webcamPreviewRef.current)
      webcamPreviewRef.current.srcObject = webcamStream.data ?? null;
  }, [screen.data?.stream, webcamStream.data]);

  const videoElement = screen.data?.videoElement;
  const aspectRatio = useMemo(() => {
    if (videoElement) return videoElement.videoWidth / videoElement.videoHeight;
    return 16 / 9;
  }, [videoElement]);

  const webcamRnd = usePreviewRnd(
    webcamPreviewRef,
    videoContainerRef,
    WEBCAM_DEFAULT_STYLE
  );
  const screenRnd = usePreviewRnd(
    screenPreviewRef,
    videoContainerRef,
    SCREEN_DEFAULT_STYLE
  );

  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  const recorder = useRecorder();

  const stopScreenCapture = () => {
    showScreen.current = false;

    screen.refetch({ cancelRefetch: false });
  };

  async function startScreenCapture() {
    showScreen.current = true;

    await screen.refetch({ cancelRefetch: false });

    // need to make sure screen size has rendered before setting webcam styles
    flushSync(() => {
      screenRnd.setStyle({
        x: 0,
        y: 0,
        width: "100%",
        height: "100%",
      });
    });

    webcamRnd.setStyle(
      getWebcamDefaultStyles(videoContainerRef.current!, "small")
    );
  }

  const [storedState] = useState(() => ({
    audioDevice: localStorage.getItem("selectedAudioDevice"),
    videoDevice: localStorage.getItem("selectedVideoDevice"),
    screenStream: localStorage.getItem("screenStream"),
  }));

  // callback ref used to ensure that 1. videoContainerRef exists and 2. that it only fires once
  const onVideoContainerMounted = useCallback((ref: HTMLDivElement) => {
    (videoContainerRef as any).current = ref;

    if (storedState.audioDevice) setAudioDeviceId(storedState.audioDevice);
    if (storedState.videoDevice) setWebcamDeviceId(storedState.videoDevice);

    webcamRnd.setStyle(
      getWebcamDefaultStyles(
        videoContainerRef.current!,
        screen.data === null ? "large" : "small"
      )
    );

    if (storedState.screenStream === "true") startScreenCapture();
  }, []);

  useLocalStoragePersist("selectedAudioDevice", audioDeviceId);
  useLocalStoragePersist("selectedVideoDevice", webcamDeviceId);
  useLocalStoragePersist("screenStream", screen.data ? "true" : undefined);

  if (recorder.isLoading) {
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
              {...(recorder.state.status === "recording" && {
                variant: "destructive",
              })}
              onClick={() => {
                if (recorder.state.status === "recording") recorder.stop();
                else if (recorder.state.status === "idle")
                  recorder.start(
                    webcamDevice,
                    webcamStream.data ?? null,
                    audioDevice,
                    videoContainerRef.current!,
                    screenPreviewRef.current ?? undefined,
                    webcamPreviewRef.current ?? undefined
                  );
              }}
              spinner={
                recorder.state.status === "starting" ||
                recorder.state.status === "stopping"
              }
            >
              {recorder.state.status === "idle" ? (
                "Start Recording"
              ) : recorder.state.status === "starting" ? (
                "Starting..."
              ) : recorder.state.status === "recording" ? (
                <>
                  Stop - <RecordingTimeText seconds={recorder.state.seconds} />
                </>
              ) : (
                recorder.state.message
              )}
            </Button>
          </div>
        </div>
        <div className="h-full flex-grow">
          <div className="w-full h-full top-0 left-0 h-full flex flex-col items-center justify-center">
            <div
              ref={onVideoContainerMounted}
              style={{
                aspectRatio: aspectRatio,
                maxWidth: "100%",
              }}
              className="video-container bg-black relative w-full mx-auto border-2 border-gray-200 rounded-xl overflow-hidden shadow-xl"
            >
              {!screen.data && !webcamStream.data && (
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
              {(screenRnd.isCenteredHorizontally ||
                webcamRnd.isCenteredHorizontally) && (
                <div
                  className="crosshair absolute top-0 left-1/2 transform -translate-x-1/2 w-0.5 h-full bg-red-500"
                  style={{ zIndex: 999 }}
                />
              )}
              {(screenRnd.isCenteredVertically ||
                webcamRnd.isCenteredVertically) && (
                <div
                  className="crosshair absolute top-1/2 left-0 transform -translate-y-1/2 w-full h-0.5 bg-red-500"
                  style={{ zIndex: 999 }}
                />
              )}
              {screen.data && (
                <Rnd {...screenRnd.props} className="absolute rnd group">
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
              {webcamStream && webcamDevice !== undefined && (
                <Rnd
                  {...webcamRnd.props}
                  default={webcamRnd.styles}
                  id="rndPreview"
                  className="absolute webcam-rnd rnd group hover:outline outline-2 outline-primary"
                  lockAspectRatio={true}
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
                  handler={async () => {
                    if (screen.data) stopScreenCapture();
                    else startScreenCapture();
                  }}
                  icon={<Monitor className="w-5 h-5" />}
                  label={screen.data ? "Hide display" : "Select display"}
                  active={true}
                />
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger className="w-full">
                  <p className="text-left text-sm font-semibold">Webcam</p>
                  <ActionButton
                    width="full"
                    icon={<Video className="w-5 h-5" />}
                    label={webcamDevice?.label ?? "None"}
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
                        setWebcamDeviceId(device.deviceId);
                        webcamRnd.setStyle(
                          getWebcamDefaultStyles(
                            videoContainerRef.current!,
                            "small"
                          )
                        );
                      }}
                    >
                      {device.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem
                    onSelect={() => {
                      setWebcamDeviceId(undefined);
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
                        webcamRnd.setStyle(
                          getWebcamDefaultStyles(
                            videoContainerRef.current!,
                            "small"
                          )
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

const resizeHandleClasses: HandleClasses = {
  bottomRight: "resize-handle",
  bottomLeft: "resize-handle",
  bottom: "resize-handle",
  right: "resize-handle",
  left: "resize-handle",
  top: "resize-handle",
  topLeft: "resize-handle",
  topRight: "resize-handle",
};

function usePreviewRnd(
  previewRef: RefObject<HTMLVideoElement>,
  containerRef: RefObject<HTMLDivElement>,
  defaultStyles: {
    x: number;
    y: number;
    width: number | string;
    height: number | string;
  }
) {
  const [isDragging, setIsDragging] = useState(false);
  const [styles, setStyle] = useState(defaultStyles);
  const [isCenteredVertically, setIsCenteredVertically] = useState(false);
  const [isCenteredHorizontally, setIsCenteredHorizontally] = useState(false);

  const props = useMemo(
    () =>
      ({
        position: {
          x: styles.x,
          y: styles.y,
        },
        size: {
          width: styles.width,
          height: styles.height,
        },
        bounds: "parent",
        resizeHandleStyles: rndHandleStyles,
        resizeHandleClasses,
        // default: styles,
        onDrag: () => {
          setIsDragging(true);
          const videoContainer = containerRef.current;
          const preview = previewRef.current;

          if (!videoContainer || !preview) return;

          const isCentered = elementIsCentered(preview, videoContainer);

          setIsCenteredVertically(isCentered.vertically);
          setIsCenteredHorizontally(isCentered.horizontally);
        },
        onDragStop: (_e, d) => {
          setIsDragging(false);

          const videoContainer = containerRef.current;
          const preview = previewRef.current;

          if (!videoContainer || !preview) return;

          const isCentered = elementIsCentered(preview, videoContainer);

          const videoContainerWidth = videoContainer.clientWidth;
          const videoContainerHeight = videoContainer.clientHeight;

          setIsCenteredHorizontally(isCentered.horizontally);
          setIsCenteredVertically(isCentered.vertically);

          setStyle((prevSettings) => ({
            ...prevSettings,
            x: isCentered.horizontally
              ? (videoContainerWidth - (prevSettings.width as number)) / 2
              : d.x,
            y: isCentered.vertically
              ? (videoContainerHeight - (prevSettings.height as number)) / 2
              : d.y,
          }));
        },
        onResizeStop: (_e, _direction, ref, _delta, position) => {
          setStyle({
            width: ref.offsetWidth,
            height: ref.offsetHeight,
            x: position.x,
            y: position.y,
          });
        },
      } satisfies ComponentProps<typeof Rnd>),
    [styles, previewRef.current, containerRef.current]
  );

  return {
    props,
    setStyle,
    isCenteredVertically: isCenteredVertically && isDragging,
    isCenteredHorizontally: isCenteredHorizontally && isDragging,
  };
}

function elementIsCentered(element: HTMLElement, container: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const previewRect = element.getBoundingClientRect();

  const containerCenterX = containerRect.left + containerRect.width / 2;
  const containerCenterY = containerRect.top + containerRect.height / 2;

  const previewCenterX = previewRect.left + previewRect.width / 2;
  const previewCenterY = previewRect.top + previewRect.height / 2;

  return {
    vertically:
      Math.abs(previewCenterY - containerCenterY) <= CENTERED_THRESHOLD,
    horizontally:
      Math.abs(previewCenterX - containerCenterX) <= CENTERED_THRESHOLD,
  };
}

async function getScreenStream() {
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

    const videoElement = document.createElement("video");
    videoElement.srcObject = stream;

    return await new Promise<{
      videoElement: HTMLVideoElement;
      stream: MediaStream;
    }>((resolve) => {
      videoElement.onloadedmetadata = () => {
        resolve({ videoElement, stream });
      };
    });
  } catch (error) {
    console.error("Error capturing screen:", error);
  }
}

async function getWebcamStream(args: {
  deviceId?: string;
  microphoneId?: string;
}) {
  try {
    const constraints: MediaStreamConstraints = {
      video: args.deviceId
        ? {
            deviceId: args.deviceId,
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          }
        : { width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: args.microphoneId ? { deviceId: args.microphoneId } : false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);

    return stream;
  } catch (error) {
    console.error("Error getting webcam stream:", error);
  }
}

function getWebcamDefaultStyles(
  { clientWidth, clientHeight }: HTMLDivElement,
  placement: "small" | "large"
) {
  if (placement === "large") {
    return {
      x: (clientWidth - clientWidth / 2) / 2,
      y: (clientHeight - clientWidth / 2) / 2,
      width: clientWidth / 2,
      height: clientWidth / 2,
    };
  }

  const webcamWidth = 180;

  return {
    x: 16,
    y: clientHeight - 16 - webcamWidth,
    width: webcamWidth,
    height: webcamWidth,
  };
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

const WEBCAM_DEFAULT_STYLE = {
  x: 16,
  y: 16,
  width: 180,
  height: 180,
};

const SCREEN_DEFAULT_STYLE = {
  x: 0,
  y: 0,
  width: "100%",
  height: "100%",
};

const rndHandleStyles = {
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

function RecordingTimeText({ seconds }: { seconds: number }) {
  const time = useRecordingTimeFormat(seconds);

  return <>{time}</>;
}

function useRecordingTimeFormat(seconds: number) {
  return useMemo(() => {
    const minutes = Math.floor(seconds / 60);
    const formattedSeconds =
      seconds % 60 < 10 ? `0${seconds % 60}` : seconds % 60;
    return `${minutes}:${formattedSeconds}`;
  }, [seconds]);
}

function useLocalStoragePersist(key: string, value?: string) {
  useEffect(() => {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  }, [key, value]);
}
