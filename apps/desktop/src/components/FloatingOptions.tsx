import { useEffect, useState } from "react";
import {
  ReactMediaRecorder,
  // useDisplayRecorder,
} from "@/utils/recording/client";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { Video } from "@/components/icons/Video";
import { Microphone } from "@/components/icons/Microphone";
// import { Screen } from "@/components/icons/Screen";
// import { Window } from "@/components/icons/Window";
import { ActionButton } from "@/components/recording/ActionButton";
import { Button } from "@/components/Button";
import { Logo } from "@/components/icons/Logo";
import { emit } from "@tauri-apps/api/event";
import { showMenu } from "tauri-plugin-context-menu";
import { invoke } from "@tauri-apps/api/tauri";

// type DisplayType = {
//   label: string;
//   track: MediaStreamTrack;
//   type: string;
// } | null;

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
        console.error("Couldn't fetch devices", error);
      }
    };

    fetchAndEmitDevices();
  }, []);

  // // Helper function to handle "Screen" or "Window" selection
  // const selectScreenOrWindow = async (sourceType: string) => {
  //   try {
  //     // Use the getDisplayMedia API for screen capture options
  //     const stream = (await navigator.mediaDevices.getDisplayMedia({
  //       video: {
  //         displaySurface: "monitor",
  //       },
  //       audio: false,
  //     })) as MediaStream;

  //     if (stream.getVideoTracks().length === 0) {
  //       return;
  //     }
  //     // Now you should have access to the id, label and other properties of the chosen screen or window
  //     const track = stream.getVideoTracks()[0];
  //     const label = track ? track.label : "No Label";

  //     // After selection, save it in the state
  //     setSelectedDisplay({ label, track, type: sourceType });

  //     // stream.getTracks().forEach((t) => t.stop()); // Stop the stream if you don't need it running
  //   } catch (error) {
  //     console.error("Failed to select screen or window:", error);
  //   }
  // };

  const handleContextClick = async (option: string) => {
    const filteredDevices = foundDevices
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
          startRecording(); // Starts webcam recording
          await invoke("start_video_recording");
        };

        // Similarly, for stopping all recordings
        const handleStopAllRecordings = async () => {
          stopRecording(); // Stops webcam recording
          await invoke("stop_video_recording");
          // stopDisplayRecording(); // Stops display recording
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
                {/* <div>
                  <button>
                    <Settings className="w-5 h-5 text-black" />
                  </button>
                </div> */}
              </div>
              <div className="space-y-4 w-full">
                {/* <div>
                  <label className="text-sm font-medium">
                    Display Settings
                  </label>

                  <div className="flex items-center space-x-1">
                    <ActionButton
                      handler={() => handleContextClick("screen")}
                      icon={<Screen className="w-5 h-5" />}
                      label={
                        selectedDisplay?.type === "screen"
                          ? selectedDisplay.label
                          : "Screen"
                      }
                    />
                    <ActionButton
                      handler={() => handleContextClick("window")}
                      icon={<Window className="w-5 h-5" />}
                      label={
                        selectedDisplay?.type === "window"
                          ? selectedDisplay.label
                          : "Window"
                      }
                    />
                  </div>
                </div> */}
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
