import { useEffect, useState } from "react";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { Video } from "@/components/icons/Video";
import { Microphone } from "@/components/icons/Microphone";
import { ActionButton } from "@/components/recording/ActionButton";
import { Button } from "@/components/Button";
import { Logo } from "@/components/icons/Logo";
import { emit } from "@tauri-apps/api/event";
import { showMenu } from "tauri-plugin-context-menu";
import { invoke } from "@tauri-apps/api/tauri";
import { Countdown } from "./Countdown";
import { appWindow, WebviewWindow } from "@tauri-apps/api/window";
import { AuthSession } from "@supabase/supabase-js";
import { supabase } from "@/utils/database/client";
import type { Database } from "@cap/utils";

export const Recorder = ({ session }: { session: AuthSession | null }) => {
  const {
    devices,
    selectedVideoDevice,
    selectedAudioDevice,
    isRecording,
    setIsRecording,
  } = useMediaDevices();
  const [countdownActive, setCountdownActive] = useState(false);

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

    // Show a context menu or dialog with the filtered devices
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
    appWindow.minimize();
    WebviewWindow.getByLabel("camera")?.minimize();
    setIsRecording(true);
    setCountdownActive(false);
  };

  const handleStartAllRecordings = async () => {
    setCountdownActive(true);
  };

  const handleStopAllRecordings = async () => {
    await invoke("stop_screen_recording");
    setIsRecording(false);
  };

  useEffect(() => {
    const startRecording = async () => {
      if (isRecording) {
        const {
          data: videoData,
          error: videoError,
        }: {
          data: Database["public"]["Tables"]["videos"]["Row"] | null;
          error: any;
        } = await supabase
          .from("videos")
          .insert({
            owner_id: session?.user?.id,
            aws_region: import.meta.env.VITE_AWS_REGION,
            aws_bucket: import.meta.env.VITE_AWS_BUCKET,
          })
          .select()
          .single();

        console.log("session:");
        console.log(session?.user?.id);
        console.log("import.meta.env.VITE_AWS_REGION:");
        console.log(import.meta.env.VITE_AWS_REGION);
        console.log("import.meta.env.VITE_AWS_BUCKET:");
        console.log(import.meta.env.VITE_AWS_BUCKET);
        console.log("videoData:");
        console.log(videoData);
        console.log("videoError:");
        console.log(videoError);

        if (videoData === null) {
          console.error("videoData is null");
          return;
        }

        if (videoData.id) {
          invoke("start_dual_recording", {
            options: {
              user_id: session?.user?.id,
              video_id: videoData.id,
              aws_region: videoData.aws_region,
              aws_bucket: videoData.aws_bucket,
              screen_index: "3",
              video_index: "0",
            },
          }).catch((error) => {
            console.error("Error invoking start_screen_recording:", error);
          });
        } else {
          console.error("videoData is null or does not contain any elements");
        }
      }
    };

    startRecording();
  }, [isRecording]);

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
          countdownFrom={1}
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
            <label className="text-sm font-medium">Webcam Settings</label>
            <div className="space-y-1">
              <ActionButton
                width="full"
                handler={() => handleContextClick("video")}
                icon={<Video className="w-5 h-5" />}
                label={selectedVideoDevice?.label || "Video"}
              />
              <ActionButton
                width="full"
                handler={() => handleContextClick("audio")}
                icon={<Microphone className="w-5 h-5" />}
                label={selectedAudioDevice?.label || "Mic"}
              />
            </div>
          </div>
          {isRecording === true ? (
            <Button
              variant="primary"
              handler={handleStopAllRecordings}
              label="Stop Recording"
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
    </div>
  );
};
