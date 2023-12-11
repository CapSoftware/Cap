import { useEffect } from "react";
import { ReactMediaRecorder } from "@/utils/recording/client";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { Video } from "@/components/icons/Video";
import { Microphone } from "@/components/icons/Microphone";
import { ActionButton } from "@/components/recording/ActionButton";
import { Button } from "@/components/Button";
import { Logo } from "@/components/icons/Logo";
import { emit } from "@tauri-apps/api/event";
import { showMenu } from "tauri-plugin-context-menu";
import { invoke } from "@tauri-apps/api/tauri";

export const FloatingOptions = () => {
  const { devices, selectedVideoDevice, selectedAudioDevice, getDevices } =
    useMediaDevices();

  useEffect(() => {
    getDevices();
  }, [getDevices]);

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
            ? device.deviceId === selectedVideoDevice?.deviceId
            : device.deviceId === selectedAudioDevice?.deviceId,
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

  return (
    <ReactMediaRecorder
      video={
        selectedVideoDevice
          ? { deviceId: selectedVideoDevice.deviceId }
          : undefined
      }
      audio={
        selectedAudioDevice
          ? { deviceId: selectedAudioDevice.deviceId }
          : undefined
      }
      render={({ status, startRecording, stopRecording }) => {
        const handleStartAllRecordings = async () => {
          startRecording();
          await invoke("start_screen_recording");
        };

        const handleStopAllRecordings = async () => {
          stopRecording();
          await invoke("stop_screen_recording");
        };

        return (
          <div
            data-tauri-drag-region
            className="w-[85%] h-[85%] flex items-center justify-center overflow-hidden px-6 py-4 rounded-[25px] border-2 border-gray-100"
            style={{
              backgroundColor: "rgba(255,255,255,0.95)",
              boxShadow: "0 0 30px rgba(0,0,0,0.2)",
            }}
          >
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
                {status === "recording" ? (
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
      }}
    />
  );
};
