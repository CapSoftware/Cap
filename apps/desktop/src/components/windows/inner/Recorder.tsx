"use client";

import { useState, useEffect } from "react";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { Video } from "@/components/icons/Video";
import { Microphone } from "@/components/icons/Microphone";
import { Screen } from "@/components/icons/Screen";
import { Window } from "@/components/icons/Window";
import { ActionButton } from "@/components/recording/ActionButton";
import { Button } from "@cap/ui";
import { Logo } from "@/components/icons/Logo";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/tauri";
import { Countdown } from "./Countdown";
import { getSelectedVideoProperties } from "@/utils/recording/utils";
import { getLatestVideoId, saveLatestVideoId } from "@/utils/database/utils";
import { openLinkInBrowser } from "@/utils/helpers";
import toast, { Toaster } from "react-hot-toast";
import { authFetch } from "@/utils/auth/helpers";

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
  // const [countdownActive, setCountdownActive] = useState(false);
  const [stoppingRecording, setStoppingRecording] = useState(false);
  const [currentStoppingMessage, setCurrentStoppingMessage] =
    useState("Stopping Recording");
  const [recordingTime, setRecordingTime] = useState("00:00");

  const handleContextClick = async (option: string) => {
    const { showMenu } = await import("tauri-plugin-context-menu");

    const filteredDevices = devices
      .filter((device) =>
        option === "video"
          ? device.kind === "videoinput"
          : device.kind === "audioinput"
      )
      .map((device) => ({
        label: device.label,
        disabled:
          option === "video"
            ? device.index === selectedVideoDevice?.index
            : device.index === selectedAudioDevice?.index,
        event: async () => {
          try {
            await emit("change-device", { type: option, device });
          } catch (error) {
            console.error("Failed to emit change-device event:", error);
          }
        },
      }));

    await showMenu({
      items: [...filteredDevices],
      ...(filteredDevices.length === 0 && {
        items: [
          {
            label: "Nothing found.",
          },
        ],
      }),
    });
  };

  // const handleOverlayFinished = () => {
  //   setIsRecording(true);
  //   setStartingRecording(false);
  //   // setCountdownActive(false);
  // };

  const prepareVideoData = async () => {
    const session = JSON.parse(localStorage.getItem("session"));
    const token = session?.token;
    const res = await authFetch(
      `${process.env.NEXT_PUBLIC_URL}/api/desktop/video/create`,
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
      return;
    }

    const data = await res.json();

    if (!data.id || !data.user_id || !data.aws_region || !data.aws_bucket) {
      console.error("No data received");
      toast.error("No data received - please try again later.");
      return;
    }

    saveLatestVideoId(data.id);

    return data;
  };

  const startDualRecording = async (videoData: {
    id: string;
    user_id: string;
    aws_region: string;
    aws_bucket: string;
  }) => {
    console.log("Starting dual recording...");
    const mediaSettings = await getSelectedVideoProperties();
    if (mediaSettings?.resolution && mediaSettings?.framerate) {
      console.log("Setting recording as active...");
      setIsRecording(true);
      setStartingRecording(false);
      await invoke("start_dual_recording", {
        options: {
          user_id: videoData.user_id,
          video_id: videoData.id,
          audio_name: selectedAudioDevice?.label,
          aws_region: videoData.aws_region,
          aws_bucket: videoData.aws_bucket,
          screen_index: "Capture screen 0",
          video_index: String(selectedVideoDevice?.index),
          ...mediaSettings,
        },
      }).catch((error) => {
        console.error("Error invoking start_screen_recording:", error);
      });
    } else {
      console.error("Invalid media settings for dual recording");
    }
  };

  const handleStartAllRecordings = async () => {
    try {
      setStartingRecording(true);
      const videoData = await prepareVideoData();
      console.log("Video data:", videoData);
      if (videoData) {
        await startDualRecording(videoData);
      } else {
        throw new Error("Failed to prepare video data.");
      }
    } catch (error) {
      console.error("Error starting recordings:", error);
      setStartingRecording(false);
      // setCountdownActive(false);
    }
  };

  const handleStopAllRecordings = async () => {
    setStoppingRecording(true);

    try {
      console.log("Stopping recordings...");

      await invoke("stop_all_recordings");

      console.log("All recordings stopped...");

      console.log("Opening window...");

      const url =
        process.env.NODE_ENV === "development"
          ? `${process.env.NEXT_PUBLIC_URL}/share/${await getLatestVideoId()}`
          : `https://cap.link/${await getLatestVideoId()}`;

      await openLinkInBrowser(url);

      setIsRecording(false);
      // setCountdownActive(false);
      setStoppingRecording(false);
    } catch (error) {
      console.error("Error stopping recording:", error);
    }

    setIsRecording(false);
    // setCountdownActive(false);
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
        className="pt-4 relative flex items-center justify-center"
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
                    handler={() => console.log("Screen option selected")}
                    icon={<Screen className="w-5 h-5" />}
                    label="Screen"
                    active={selectedDisplayType === "screen"}
                  />
                  <ActionButton
                    handler={() => toast.error("This option is coming soon!")}
                    icon={<Window className="w-5 h-5" />}
                    label="Window"
                    active={selectedDisplayType === "window"}
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">Webcam / Video</label>
                <div className="space-y-1">
                  <ActionButton
                    width="full"
                    handler={() => handleContextClick("video")}
                    icon={<Video className="w-5 h-5" />}
                    label={selectedVideoDevice?.label || "Video"}
                    active={selectedVideoDevice !== null}
                  />
                  <ActionButton
                    width="full"
                    handler={() => handleContextClick("audio")}
                    icon={<Microphone className="w-5 h-5" />}
                    label={selectedAudioDevice?.label || "Mic"}
                    active={selectedAudioDevice !== null}
                  />
                </div>
              </div>
            </div>
          </div>
          <Button
            {...(isRecording && { variant: "destructive" })}
            className="w-[97.6%] flex mx-auto"
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
        </div>
        <Toaster />
      </div>
    </>
  );
};
