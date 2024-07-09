"use client";

import { useState, useEffect } from "react";
import { Device, useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { Video } from "@/components/icons/Video";
import { Microphone } from "@/components/icons/Microphone";
import { Screen } from "@/components/icons/Screen";
import { Window } from "@/components/icons/Window";
import { ActionButton } from "@/components/windows/inner/ActionButton";
import { Button } from "@cap/ui";
import { Logo } from "@/components/icons/Logo";
import { emit, listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/tauri";
import {
  getLatestVideoId,
  saveLatestVideoId,
  saveUserId,
  getUserId,
  isUserPro,
} from "@cap/utils";
import { openLinkInBrowser } from "@/utils/helpers";
import * as commands from "@/utils/commands";
import toast, { Toaster } from "react-hot-toast";
import { authFetch } from "@/utils/auth/helpers";

declare global {
  interface Window {
    fathom: any;
  }
}

export const Recorder = () => {
  const {
    devices,
    selectedVideoDevice,
    selectedAudioDevice,
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

  useEffect(() => {
    proCheckPromise.then((result) => setProCheck(Boolean(result)));
  }, [proCheckPromise]);

  const handleContextClick = async (option: "video" | "audio") => {
    const { showMenu } = await import("tauri-plugin-context-menu");
    const deviceKind = option === "video" ? "videoinput" : "audioinput";
    const isSelected = (device: Device | null) => {
      if (device === null) {
        return deviceKind === "videoinput"
          ? selectedVideoDevice === null
          : selectedAudioDevice === null;
      }

      return deviceKind === "videoinput"
        ? device.index === selectedVideoDevice?.index
        : device.index === selectedAudioDevice?.index;
    };
    const select = async (device: Device | null) => {
      // if (isSelected(device)) {
      //   return
      // }
      emit("change-device", { type: deviceKind, device: device }).catch(
        (error) => {
          console.log("Failed to emit change-device event:", error);
        }
      );
    };

    const devicesOfKind = devices.filter(
      (device) => device.kind === deviceKind
    );

    const menuItems = [
      {
        label: "None",
        checked: isSelected(null),
        event: async () => select(null),
      },
      ...devicesOfKind.map((device) => ({
        label: device.label,
        checked: isSelected(device),
        event: async () => select(device),
      })),
    ];

    await showMenu({
      items: [...menuItems],
      ...(devicesOfKind.length === 0 && {
        items: [
          {
            label: "Nothing found.",
          },
        ],
      }),
    });
  };

  const prepareVideoData = async () => {
    const session = JSON.parse(localStorage.getItem("session"));
    const token = session?.token;
    const res = await authFetch(
      `${process.env.NEXT_PUBLIC_URL}/api/desktop/video/create?origin=${window.location.origin}`,
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
    let unlistenFn: UnlistenFn | null = null;

    const setupListener = async () => {
      unlistenFn = await listen("tray-on-left-click", (_) => {
        if (isRecording) {
          handleStopAllRecordings();
        }

        tauriWindow.then(({ getCurrent }) => {
          const currentWindow = getCurrent();
          if (!currentWindow.isVisible) {
            currentWindow.show();
          }
          if (currentWindow.isMinimized()) {
            currentWindow.unminimize();
          }
          currentWindow.setFocus();
        });
      });
    };

    setupListener();

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
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
    tauriWindow.then(({ getAll }) => {
      getAll().forEach((window) => {
        if (window.label !== "camera") {
          window.minimize();
        }
      });
    });
    await emit("toggle-recording", true);
    try {
      await commands
        .startDualRecording({
          user_id: videoData.user_id,
          video_id: videoData.id,
          audio_name: selectedAudioDevice?.label ?? "None",
          aws_region: videoData.aws_region,
          aws_bucket: videoData.aws_bucket,
          screen_index: "Capture screen 0",
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
    try {
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
    setStoppingRecording(true);

    try {
      tauriWindow.then(({ WebviewWindow }) => {
        const main = WebviewWindow.getByLabel("main");
        if (main && main.isMinimized()) {
          main.unminimize();
        }
      });
    } catch (error) {
      console.error("Error unminimizing main window:", error);
    }

    try {
      console.log("Stopping recordings...");

      try {
        await commands.stopAllRecordings();
      } catch (error) {
        console.error("Error stopping recording:", error);
      }

      if (window.fathom !== undefined) {
        window.fathom.trackEvent("stop_recording");
      }

      console.log("All recordings stopped...");

      console.log("Opening window...");

      const url =
        process.env.NEXT_PUBLIC_ENVIRONMENT === "development"
          ? `${process.env.NEXT_PUBLIC_URL}/s/${await getLatestVideoId()}`
          : `https://cap.link/${await getLatestVideoId()}`;

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
      await emit("toggle-recording", false);
    } catch (error) {
      console.error("Error stopping recording:", error);
    }

    setIsRecording(false);
    setStoppingRecording(false);
  };

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
          tauriWindow.then(({ getCurrent }) => {
            const currentWindow = getCurrent();
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
        className="w-full h-full px-3 pt-4 relative flex items-center justify-center"
      >
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
                  <ActionButton
                    width="full"
                    handler={() => handleContextClick("video")}
                    icon={<Video className="w-5 h-5" />}
                    label={
                      devices.length === 0
                        ? "Video"
                        : selectedVideoDevice?.label || "None"
                    }
                    active={selectedVideoDevice !== null}
                    recordingOption={true}
                    optionName="Video"
                  />
                  <ActionButton
                    width="full"
                    handler={() => handleContextClick("audio")}
                    icon={<Microphone className="w-5 h-5" />}
                    label={
                      devices.length === 0
                        ? "Mic"
                        : selectedAudioDevice?.label || "None"
                    }
                    active={selectedAudioDevice !== null}
                    recordingOption={true}
                    optionName="Audio"
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
                ? currentStoppingMessage
                : `Stop - ${recordingTime}`
              : "Start Recording"}
          </Button>
          <div className="text-center mt-3">
            {proCheck === false ? (
              <p className="text-sm text-gray-600">5 min recording limit</p>
            ) : (
              <p className="text-sm text-gray-600">No recording limit</p>
            )}
          </div>
        </div>
        <Toaster />
      </div>
    </>
  );
};
