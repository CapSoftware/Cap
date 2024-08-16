"use client";

import { useState, useEffect, useRef } from "react";
import {
  Device,
  DeviceKind,
  useMediaDevices,
} from "@/utils/recording/MediaDeviceContext";
import { Video } from "@/components/icons/Video";
import { VideoOff } from "@/components/icons/VideoOff";
import { Microphone } from "@/components/icons/Microphone";
import { MicrophoneOff } from "@/components/icons/MicrophoneOff";
import { Screen } from "@/components/icons/Screen";
import { Window } from "@/components/icons/Window";
import { Scaling } from "@/components/icons/Scaling";
import { Logo } from "@/components/icons/Logo";
import { ActionButton } from "./ActionButton";
import { ActionSelect } from "./ActionSelect";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@cap/ui";
import { emit, listen, UnlistenFn } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import {
  getLatestVideoId,
  saveLatestVideoId,
  saveUserId,
  getUserId,
  isUserPro,
} from "@cap/utils";
import { openLinkInBrowser } from "@/utils/helpers";
import { commands, events, ProgressInfo } from "@/utils/commands";
import toast, { Toaster } from "react-hot-toast";
import { authFetch } from "@/utils/auth/helpers";
import { setTrayStopIcon } from "@/utils/tray";
import { OutputResolution } from "@/utils/recording/utils";

declare global {
  interface Window {
    fathom: any;
  }
}

export const Recorder = () => {
  const {
    devices,
    selectedVideoDevice,
    lastSelectedVideoDevice,
    selectedAudioDevice,
    lastSelectedAudioDevice,
    selectedDisplayType,
    isRecording,
    setIsRecording,
    startingRecording,
    setStartingRecording,
  } = useMediaDevices();
  const [stoppingRecording, setStoppingRecording] = useState(false);
  const [currentStoppingMessage, setCurrentStoppingMessage] =
    useState("Stopping Recording");
  const [recordingTime, setRecordingTime] = useState("00:00");
  const [hasStartedRecording, setHasStartedRecording] = useState(false);
  const tauriWindow = import("@tauri-apps/api/window");
  const proCheckPromise = isUserPro();
  const [proCheck, setProCheck] = useState<boolean>(false);
  const [limitReached, setLimitReached] = useState(false);
  const [outputResolution, setOutputResolution] = useState<OutputResolution>(
    OutputResolution._720p
  );
  const [uploadProgressInfo, setUploadProgressInfo] =
    useState<ProgressInfo | null>(null);

  useEffect(() => {
    proCheckPromise.then((result) => setProCheck(Boolean(result)));
  }, [proCheckPromise]);

  const selectDevice = (kind: DeviceKind, device: Device | null) =>
    emit("cap://av/set-device", { type: kind, device: device }).catch((error) =>
      console.log("Failed to emit cap://av/set-device event:", error)
    );

  const createDeviceMenuOptions = (kind: DeviceKind) => [
    {
      value: "_",
      label: `Select ${kind === "videoinput" ? "Video" : "Microphone"}`,
      disabled: true,
    },
    { value: "none", label: `No ${kind === "videoinput" ? "Video" : "Audio"}` },
    ...devices
      .filter((device) => device.kind === kind)
      .map(({ label }) => ({ value: label, label })),
  ];

  const handleSelectInputDevice = async (kind: DeviceKind, label: string) => {
    let device: Device | null = null;
    if (label !== "none")
      device =
        devices.find(
          (device) => device.kind === kind && device.label === label
        ) || null;
    selectDevice(kind, device);
  };

  const prepareVideoData = async () => {
    const session = JSON.parse(localStorage.getItem("session"));
    const token = session?.token;
    const res = await authFetch(
      `${process.env.NEXT_PUBLIC_URL}/api/desktop/video/create?origin=${window.location.origin}&recordingMode=hls`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (res.status === 401) {
      console.error("Unauthorized");
      toast.error("Unauthorized - please sign in again.");
      localStorage.removeItem("session");
      if (typeof window !== "undefined") {
        window.location.reload();
      }
      return;
    }

    const data = await res.json();

    if (!data.id || !data.user_id || !data.aws_region || !data.aws_bucket) {
      console.error("No data received");
      toast.error("No data received - please try again later.");
      return;
    }

    saveLatestVideoId(data.id);
    saveUserId(data.user_id);

    return data;
  };

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    const setup = async () => {
      unlisten = await listen<void>("cap://tray/clicked", async (_) => {
        if (isRecording) {
          await handleStopAllRecordings();
        }

        tauriWindow.then(({ getAllWindows }) =>
          getAllWindows().forEach((window) => {
            window.show();
            window.setFocus();
          })
        );
      });
    };
    setup();

    return () => {
      unlisten?.();
    };
  }, [isRecording]);

  const startDualRecording = async (videoData: {
    id: string;
    user_id: string;
    aws_region: string;
    aws_bucket: string;
  }) => {
    if (hasStartedRecording) {
      console.log("Recording has already started.");
      return;
    }
    console.log("Starting dual recording...");
    setIsRecording(true);
    setStartingRecording(false);
    setHasStartedRecording(true);
    if (window.fathom !== undefined) {
      window.fathom.trackEvent("start_recording");
    }
    tauriWindow.then(({ getAllWindows }) => {
      getAllWindows().forEach((window) => {
        if (window.label !== "camera") {
          window.minimize();
        }
      });
    });
    setTrayStopIcon(true);
    try {
      await commands
        .startDualRecording({
          user_id: videoData.user_id,
          video_id: videoData.id,
          audio_name: selectedAudioDevice?.label ?? "None",
          aws_region: videoData.aws_region,
          aws_bucket: videoData.aws_bucket,
          screen_index: "Capture screen 0",
          resolution: "Captured",
          video_index: String(selectedVideoDevice?.index),
        })
        .catch((error) => {
          console.error("Error invoking start_screen_recording:", error);
        });
    } catch (error) {
      console.error("Error starting screen recording:", error);
      setStartingRecording(false);
    }
  };

  const handleStartAllRecordings = async () => {
    if (isRecording) return;
    try {
      console.log("bruh");
      setStartingRecording(true);
      const videoData =
        process.env.NEXT_PUBLIC_LOCAL_MODE &&
        process.env.NEXT_PUBLIC_LOCAL_MODE === "true"
          ? {
              id: "test",
              user_id: "test",
              aws_region: "test",
              aws_bucket: "test",
            }
          : await prepareVideoData();
      console.log("Video data :", videoData);
      if (videoData) {
        await startDualRecording(videoData);
      } else {
        throw new Error("Failed to prepare video data.");
      }
    } catch (error) {
      console.error("Error starting recordings:", error);
      setStartingRecording(false);
    }
  };

  const handleStopAllRecordings = async () => {
    if (!isRecording) return;
    setStoppingRecording(true);

    try {
      tauriWindow.then(({ Window }) => {
        const main = Window.getByLabel("main");
        if (main?.isMinimized()) main.unminimize();
      });
    } catch (error) {
      console.error("Error unminimizing main window:", error);
    }

    try {
      console.log("Stopping recordings...");

      let unlistenUploadProgress = await events.uploadProgressEvent.listen(
        (event) => setUploadProgressInfo(event.payload)
      );

      try {
        await commands.stopAllRecordings();
      } catch (error) {
        console.error("Error stopping recording:", error);
      }

      if (window.fathom !== undefined) {
        window.fathom.trackEvent("stop_recording");
      }

      unlistenUploadProgress();
      console.log("All recordings stopped...");

      console.log("Opening window...");

      const url =
        process.env.NEXT_PUBLIC_ENVIRONMENT === "development"
          ? `${process.env.NEXT_PUBLIC_URL}/s/${getLatestVideoId()}`
          : `https://cap.link/${getLatestVideoId()}`;

      const audio = new Audio("/recording-end.mp3");
      await audio.play();

      if (
        !process.env.NEXT_PUBLIC_LOCAL_MODE ||
        process.env.NEXT_PUBLIC_LOCAL_MODE !== "true"
      ) {
        await openLinkInBrowser(url);
      }

      setIsRecording(false);
      setHasStartedRecording(false);
      setStoppingRecording(false);
      setTrayStopIcon(false);
    } catch (error) {
      console.error("Error stopping recording:", error);
    }

    setIsRecording(false);
    setStoppingRecording(false);
  };

  useKeybinds(handleStartAllRecordings, handleStopAllRecordings);

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
    if (isRecording && !startingRecording && !proCheck && !limitReached) {
      const startTime = Date.now();
      let intervalId: NodeJS.Timeout;

      intervalId = setInterval(() => {
        const seconds = Math.floor((Date.now() - startTime) / 1000);
        if (seconds >= 300) {
          setLimitReached(true);
          tauriWindow.then(({ getCurrentWindow }) => {
            const currentWindow = getCurrentWindow();
            if (currentWindow.isMinimized()) {
              currentWindow.unminimize();
              toast.error(
                "5 minute recording limit reached. Stopping recording in 10 seconds."
              );

              setTimeout(() => {
                handleStopAllRecordings();
                return;
              }, 10000);
            }
          });
        }
      }, 1000);

      return () => {
        clearInterval(intervalId);
        setLimitReached(false);
      };
    }
  }, [isRecording, startingRecording, proCheck, limitReached]);

  return (
    <>
      {/* {countdownActive && (
        <Countdown
          countdownFrom={3}
          onCountdownFinish={handleOverlayFinished}
        />
      )} */}
      <div
        data-tauri-drag-region
        className="w-full h-screen flex flex-col px-3 pt-4"
      >
        <div className="mt-10">
          <div className="w-full">
            <div
              className={`${
                isRecording === true && "blur-sm pointer-events-none"
              } mb-4`}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <Logo className="w-24 h-auto" />
                </div>
              </div>
              <div className="space-y-4 mb-4 w-full">
                <div>
                  <label className="text-sm font-medium">Display</label>
                  <div className="flex items-center space-x-1">
                    <ActionButton
                      handler={() => {
                        console.log("Screen option selected");
                        if (window.fathom !== undefined) {
                          window.fathom.trackEvent("screen_option");
                        }
                      }}
                      icon={<Screen className="w-5 h-5" />}
                      label="Full screen"
                      active={selectedDisplayType === "screen"}
                    />
                    <ActionButton
                      handler={() => {
                        toast.error("This option is coming soon!");
                        if (window.fathom !== undefined) {
                          window.fathom.trackEvent("window_option");
                        }
                      }}
                      icon={<Window className="w-5 h-5" />}
                      label="Window"
                      active={selectedDisplayType === "window"}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium">Webcam / Video</label>
                  <div className="space-y-2">
                    <ActionSelect
                      options={createDeviceMenuOptions("videoinput")}
                      onStatusClick={(status) => {
                        selectDevice(
                          "videoinput",
                          status === "on" ? null : lastSelectedVideoDevice
                        );
                      }}
                      showStatus={true}
                      status={selectedVideoDevice === null ? "off" : "on"}
                      iconEnabled={<Video className="w-5 h-5" />}
                      iconDisabled={<VideoOff className="w-5 h-5" />}
                      selectedValue={selectedVideoDevice?.label}
                      onSelect={(value) =>
                        handleSelectInputDevice("videoinput", value as string)
                      }
                    />
                    <ActionSelect
                      options={createDeviceMenuOptions("audioinput")}
                      onStatusClick={(status) => {
                        selectDevice(
                          "audioinput",
                          status === "on" ? null : lastSelectedAudioDevice
                        );
                      }}
                      showStatus={true}
                      status={selectedAudioDevice === null ? "off" : "on"}
                      iconEnabled={<Microphone className="w-5 h-5" />}
                      iconDisabled={<MicrophoneOff className="w-5 h-5" />}
                      selectedValue={selectedAudioDevice?.label}
                      onSelect={(value) =>
                        handleSelectInputDevice("audioinput", value as string)
                      }
                    />
                  </div>
                </div>
              </div>
            </div>
            <Button
              {...(isRecording && { variant: "destructive" })}
              className="w-full flex mx-auto"
              onClick={() => {
                if (isRecording) {
                  handleStopAllRecordings();
                } else {
                  handleStartAllRecordings();
                }
              }}
              spinner={startingRecording || stoppingRecording}
            >
              {startingRecording
                ? "Starting..."
                : isRecording
                ? stoppingRecording
                  ? `${currentStoppingMessage} (${uploadProgressInfo?.progress}%)`
                  : `Stop - ${recordingTime}`
                : "Start Recording"}
            </Button>
          </div>
        </div>
        <div className="flex flex-col items-center mt-2 mb-6 space-y-1 cursor-pointer">
          <div>
            {(!stoppingRecording || !isRecording) && (
              <Popover>
                <PopoverTrigger>
                  <p
                    className="text-sm text-gray-800"
                    onClick={() => {
                      // TODO: Implement window.
                      console.log("Clicked");
                    }}
                  >
                    Quality:{" "}
                    <span className="underline">
                      {outputResolution.toString()}
                    </span>
                  </p>
                </PopoverTrigger>
                <PopoverContent className="bg-white w-64">
                  Select resolution
                </PopoverContent>
              </Popover>
            )}
            {stoppingRecording && (
              <p className="text-sm text-gray-600">
                Uploading at{" "}
                {(uploadProgressInfo?.speed / 1_000_000.0).toFixed(2)}
                <span>MB/s</span>
              </p>
            )}
          </div>
          <p className="text-sm text-gray-600">
            {proCheck === false
              ? "5 min recording limit"
              : "No recording limit"}
          </p>
        </div>

        <Toaster />
      </div>
    </>
  );
};

function useKeybinds(startRecording: () => void, stopRecording: () => void) {
  const handlers = useRef({
    startRecording,
    stopRecording,
  });
  handlers.current = {
    startRecording,
    stopRecording,
  };

  useEffect(() => {
    // register("CommandOrControl+Shift+R", () =>
    //   handlers.current.startRecording()
    // );
    // register("CommandOrControl+Shift+S", () =>
    //   handlers.current.stopRecording()
    // );
    // return () => {
    //   unregister(["CommandOrControl+Shift+R", "CommandOrControl+Shift+S"]);
    // };
  }, []);
}
