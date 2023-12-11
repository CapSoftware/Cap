import {
  useState,
  createContext,
  useContext,
  useEffect,
  useCallback,
} from "react";
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
  devices: MediaDeviceInfo[];
  getDevices: () => Promise<void>;
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
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  const getDevices = useCallback(async () => {
    const fetchedDevices = await navigator.mediaDevices.enumerateDevices();
    setDevices(fetchedDevices);

    // Automatically select the first available devices if not already selected
    if (!selectedVideoDevice) {
      const videoInput = fetchedDevices.find(
        (device) => device.kind === "videoinput"
      );
      setSelectedVideoDevice(videoInput || null);
    }
    if (!selectedAudioDevice) {
      const audioInput = fetchedDevices.find(
        (device) => device.kind === "audioinput"
      );
      setSelectedAudioDevice(audioInput || null);
    }
  }, [selectedVideoDevice, selectedAudioDevice]);

  useEffect(() => {
    getDevices();
  }, [getDevices]);

  useEffect(() => {
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

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [selectedVideoDevice, selectedAudioDevice]);

  return (
    <MediaDeviceContext.Provider
      value={{
        selectedVideoDevice,
        setSelectedVideoDevice,
        selectedAudioDevice,
        setSelectedAudioDevice,
        devices,
        getDevices,
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
