import { useState, createContext, useContext, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { DeviceChangePayload } from "@/utils/types/shared";

// Define the type of the context data
interface MediaDeviceContextData {
  selectedVideoDevice: MediaDeviceInfo | null;
  setSelectedVideoDevice: React.Dispatch<
    React.SetStateAction<MediaDeviceInfo | null>
  >;
  selectedAudioDevice: MediaDeviceInfo | null;
  setSelectedAudioDevice: React.Dispatch<
    React.SetStateAction<MediaDeviceInfo | null>
  >;
}

export const MediaDeviceContext = createContext<
  MediaDeviceContextData | undefined
>(undefined);

export const MediaDeviceProvider: React.FC<React.PropsWithChildren<{}>> = ({
  children,
}) => {
  const [selectedVideoDevice, setSelectedVideoDevice] =
    useState<MediaDeviceInfo | null>(null);
  const [selectedAudioDevice, setSelectedAudioDevice] =
    useState<MediaDeviceInfo | null>(null);

  // useEffect(() => {
  //   const passVideoDeviceState = async () => {
  //     try {
  //       if (selectedVideoDevice === null) return;
  //       await emit("change-device", {
  //         type: "video",
  //         device: selectedVideoDevice,
  //       });
  //     } catch (error) {
  //       console.error("Error emitting event:", error);
  //     }
  //   };

  //   passVideoDeviceState();
  // }, [selectedVideoDevice]);

  // useEffect(() => {
  //   const passAudioDeviceState = async () => {
  //     try {
  //       if (selectedAudioDevice === null) return;
  //       await emit("change-device", {
  //         type: "audio",
  //         device: selectedAudioDevice,
  //       });
  //     } catch (error) {
  //       console.error("Error emitting event:", error);
  //     }
  //   };

  //   passAudioDeviceState();
  // }, [selectedAudioDevice]);

  useEffect(() => {
    // Initialize the event listener
    let unlistenFn: any;

    const setupListener = async () => {
      try {
        unlistenFn = await listen(
          "change-device",
          ({ payload }: { payload: DeviceChangePayload }) => {
            if (payload && payload.device) {
              if (payload.type === "video") {
                console.log("receiving video payload:");
                console.log(payload);
                if (selectedVideoDevice?.deviceId !== payload.device.deviceId) {
                  setSelectedVideoDevice(payload.device);
                }
              }

              if (payload.type === "audio") {
                console.log("receiving audio payload:");
                console.log(payload);
                if (selectedAudioDevice?.deviceId !== payload.device.deviceId) {
                  setSelectedAudioDevice(payload.device);
                }
              }
            }
          }
        );
      } catch (error) {
        console.error("Error setting up listener:", error);
      }
    };

    setupListener();

    // Cleanup function to unlisten when the component unmounts
    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  return (
    <MediaDeviceContext.Provider
      value={{
        selectedVideoDevice,
        setSelectedVideoDevice,
        selectedAudioDevice,
        setSelectedAudioDevice,
      }}
    >
      {children}
    </MediaDeviceContext.Provider>
  );
};

export const useMediaDevices = () => {
  const context = useContext(MediaDeviceContext);

  if (context === undefined) {
    throw new Error(
      "useMediaDevices must be used within a MediaDeviceProvider"
    );
  }

  return context;
};
