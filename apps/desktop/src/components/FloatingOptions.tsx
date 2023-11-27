import { useEffect, useState } from "react";
import { ReactMediaRecorder } from "@/utils/recording/client";
import { showMenu } from "tauri-plugin-context-menu";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { Video } from "@/components/icons/Video";
import { Microphone } from "@/components/icons/Microphone";
import { Screen } from "@/components/icons/Screen";
import { ActionButton } from "@/components/recording/ActionButton";
import { Button } from "@/components/Button";
import { Logo } from "@/components/icons/Logo";
// import { Settings } from "@/components/icons/Settings";
import { emit } from "@tauri-apps/api/event";

export const FloatingOptions = () => {
  const [foundDevices, setFoundDevices] = useState<MediaDeviceInfo[]>([]);
  const { selectedVideoDevice, selectedAudioDevice } = useMediaDevices();

  useEffect(() => {
    const fetchAndEmitDevices = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true,
        });

        stream.getTracks().forEach((track) => track.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const filteredDevices = devices.filter(
          (device) =>
            device.kind === "audioinput" || device.kind === "videoinput"
        );

        setFoundDevices(filteredDevices);

        if (selectedVideoDevice === null) {
          const videoDevice = filteredDevices.find(
            (device) => device.kind === "videoinput"
          );

          if (videoDevice) {
            console.log("emitting video");

            await emit("change-device", {
              type: "video",
              device: videoDevice,
            });
          }
        }

        if (selectedAudioDevice === null) {
          const audioDevice = filteredDevices.find(
            (device) => device.kind === "audioinput"
          );

          if (audioDevice) {
            console.log("emitting audio");

            await emit("change-device", {
              type: "audio",
              device: audioDevice,
            });
          }
        }
      } catch (error) {
        console.error(error);
      }
    };

    fetchAndEmitDevices();
  }, []);

  const handleContextClick = async (option: string) => {
    showMenu({
      items: [
        ...foundDevices
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
          })),
      ],
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
                {/* <div>
                  <button>
                    <Settings className="w-5 h-5 text-black" />
                  </button>
                </div> */}
              </div>
              <div className="space-y-4 w-full">
                <div>
                  <label className="text-sm font-medium">Screen Settings</label>
                  <ActionButton
                    handler={() => handleContextClick("screen")}
                    icon={<Screen className="w-5 h-5" />}
                    label="Screen"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">
                    Recording Settings
                  </label>
                  <div className="space-y-2">
                    <ActionButton
                      handler={() => handleContextClick("video")}
                      icon={<Video className="w-5 h-5" />}
                      label={selectedVideoDevice?.label || "Video"}
                    />
                    <ActionButton
                      handler={() => handleContextClick("audio")}
                      icon={<Microphone className="w-5 h-5" />}
                      label={selectedAudioDevice?.label || "Mic"}
                    />
                  </div>
                </div>
                {status === "recording" ? (
                  <Button
                    variant="primary"
                    handler={stopRecording}
                    label="Stop Recording"
                  />
                ) : (
                  <Button
                    variant="primary"
                    handler={startRecording}
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
