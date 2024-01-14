import { useState, useEffect } from "react";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { Video } from "@/components/icons/Video";
import { Microphone } from "@/components/icons/Microphone";
import { Screen } from "@/components/icons/Screen";
import { Window } from "@/components/icons/Window";
import { ActionButton } from "@/components/recording/ActionButton";
import { Button } from "@/components/Button";
import { Logo } from "@/components/icons/Logo";
import { emit } from "@tauri-apps/api/event";
import { showMenu } from "tauri-plugin-context-menu";
import { invoke } from "@tauri-apps/api/tauri";
import { Countdown } from "./Countdown";
import { AuthSession } from "@supabase/supabase-js";
import { supabase } from "@/utils/database/client";
import type { Database } from "@cap/utils";
import { useMediaRecorder } from "@/utils/recording/useMediaRecorder";
import { getSelectedVideoProperties } from "@/utils/recording/utils";
import { getLatestVideoId, saveLatestVideoId } from "@/utils/database/utils";
import { openLinkInBrowser } from "@/utils/helpers";
import { uuidParse } from "@cap/utils";
import toast, { Toaster } from "react-hot-toast";
import { LogicalSize, WebviewWindow, appWindow } from "@tauri-apps/api/window";

export const Recorder = ({ session }: { session: AuthSession | null }) => {
  const {
    devices,
    selectedVideoDevice,
    selectedAudioDevice,
    selectedDisplayType,
    isRecording,
    setIsRecording,
  } = useMediaDevices();
  const [countdownActive, setCountdownActive] = useState(false);
  const [stoppingRecording, setStoppingRecording] = useState(false);
  const [currentStoppingMessage, setCurrentStoppingMessage] =
    useState("Stopping Recording");
  const { startMediaRecording, stopMediaRecording } = useMediaRecorder();

  const handleContextClick = async (option: string) => {
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

    showMenu({
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

  const handleOverlayFinished = () => {
    appWindow.setSize(new LogicalSize(0, 0));
    WebviewWindow.getByLabel("camera")?.setSize(new LogicalSize(0, 0));
    setIsRecording(true);
    setCountdownActive(false);
  };

  const prepareVideoData = async () => {
    return await supabase
      .from("videos")
      .insert({
        owner_id: session?.user?.id,
        aws_region: import.meta.env.VITE_AWS_REGION,
        aws_bucket: import.meta.env.VITE_AWS_BUCKET,
      })
      .select()
      .single()
      .then(
        ({
          data,
          error,
        }: {
          data: Database["public"]["Tables"]["videos"]["Row"] | null;
          error: any;
        }) => {
          if (error) {
            console.error("Error fetching video data:", error);
            return null;
          }
          if (!data) {
            console.error("No video data received");
            return null;
          }
          saveLatestVideoId(data.id);
          return data;
        }
      );
  };

  const startDualRecording = async (videoData: {
    id: any;
    aws_region: any;
    aws_bucket: any;
  }) => {
    // Extracted from the useEffect hook; this starts the video recording
    const mediaSettings = await getSelectedVideoProperties();
    if (mediaSettings?.resolution && mediaSettings?.framerate) {
      await invoke("start_dual_recording", {
        options: {
          user_id: session?.user?.id,
          video_id: videoData.id,
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
    setCountdownActive(true);

    try {
      const videoData = await prepareVideoData();
      if (videoData) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: selectedAudioDevice?.deviceId },
          video: { deviceId: selectedVideoDevice?.deviceId },
        });
        await startMediaRecording(stream);
        await startDualRecording(videoData);
      } else {
        throw new Error("Failed to prepare video data.");
      }
    } catch (error) {
      console.error("Error starting recordings:", error);
      setCountdownActive(false);
    }
  };

  const handleStopAllRecordings = async () => {
    setStoppingRecording(true);

    try {
      console.log("Stopping recordings...");

      await stopMediaRecording();

      await invoke("stop_all_recordings");

      console.log("Recordings stopped...");

      console.log("Opening window...");

      await openLinkInBrowser(
        `${import.meta.env.VITE_PUBLIC_URL}/share/${uuidParse(
          await getLatestVideoId()
        )}`
      );

      setIsRecording(false);
      setCountdownActive(false);
      setStoppingRecording(false);
    } catch (error) {
      console.error("Error invoking upload_file:", error);
    }

    setIsRecording(false);
    setCountdownActive(false);
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

      const intervalId = setInterval(nextMessage, 2000);

      return () => clearInterval(intervalId);
    } else {
      setCurrentStoppingMessage("");
    }
  }, [stoppingRecording]);

  return (
    <div
      data-tauri-drag-region
      className="w-[85%] h-[85%] relative flex items-center justify-center overflow-hidden px-6 py-4 rounded-[25px] border-2 border-gray-100"
      style={{
        backgroundColor: "rgba(255,255,255,0.9)",
        boxShadow: "0 0 30px rgba(0,0,0,0.2)",
      }}
    >
      {countdownActive && (
        <Countdown
          countdownFrom={3}
          onCountdownFinish={handleOverlayFinished}
        />
      )}
      <div className="w-full">
        <div className="flex items-center justify-between mb-4">
          <div>
            <Logo className="w-24 h-auto" />
          </div>
        </div>
        <div className="space-y-4 w-full">
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
          {isRecording === true ? (
            <Button
              variant="primary"
              handler={handleStopAllRecordings}
              label={
                stoppingRecording ? currentStoppingMessage : "Stop Recording"
              }
              spinner={stoppingRecording}
            />
          ) : (
            <Button
              variant="primary"
              handler={handleStartAllRecordings}
              label="Start Recording"
            />
          )}
        </div>
      </div>
      <Toaster />
    </div>
  );
};
