import {
  useState,
  createContext,
  useContext,
  useEffect,
  useCallback,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/tauri";

interface Devices {
  index: number;
  label: string;
  kind: "videoinput" | "audioinput";
}

interface DeviceList {
  video_devices: string[];
  audio_devices: string[];
}

// Define the type of the context data
interface MediaDeviceContextData {
  selectedVideoDevice: Devices | null;
  setSelectedVideoDevice: React.Dispatch<React.SetStateAction<Devices | null>>;
  selectedAudioDevice: Devices | null;
  setSelectedAudioDevice: React.Dispatch<React.SetStateAction<Devices | null>>;
  devices: Devices[];
  getDevices: () => Promise<void>;
  isRecording: boolean;
  setIsRecording: React.Dispatch<React.SetStateAction<boolean>>;
}

export const MediaDeviceContext = createContext<
  MediaDeviceContextData | undefined
>(undefined);

export const MediaDeviceProvider: React.FC<React.PropsWithChildren<{}>> = ({
  children,
}) => {
  const [selectedVideoDevice, setSelectedVideoDevice] =
    useState<Devices | null>(null);
  const [selectedAudioDevice, setSelectedAudioDevice] =
    useState<Devices | null>(null);
  const [devices, setDevices] = useState<Devices[]>([]);
  const [isRecording, setIsRecording] = useState(false);

  const getDevices = useCallback(async () => {
    console.log("getDevices called");

    try {
      const deviceList = (await invoke("list_devices")) as DeviceList;
      const { video_devices, audio_devices } = deviceList;

      console.log("deviceList:");
      console.log(deviceList);

      const formattedDevices = [
        ...(video_devices.map((device, index) => ({
          index: index,
          label: device,
          kind: "videoinput",
        })) as Devices[]),
        ...(audio_devices.map((device, index) => ({
          index: index,
          label: device,
          kind: "audioinput",
        })) as Devices[]),
      ];
      setDevices(formattedDevices);

      // Automatically select the first available devices if not already selected
      if (!selectedVideoDevice) {
        const videoInput = formattedDevices.find(
          (device) => device.kind === "videoinput"
        );
        setSelectedVideoDevice(videoInput || null);
      }
      if (!selectedAudioDevice) {
        const audioInput = formattedDevices.find(
          (device) => device.kind === "audioinput"
        );
        setSelectedAudioDevice(audioInput || null);
      }
    } catch (error) {
      console.error("Failed to get media devices:", error);
    }
  }, [selectedVideoDevice, selectedAudioDevice]);

  useEffect(() => {
    getDevices();
  }, []);

  useEffect(() => {
    let unlistenFn: any;

    const setupListener = async () => {
      try {
        unlistenFn = await listen(
          "change-device",
          ({
            payload,
          }: {
            payload: { type: "video" | "audio"; device: Devices };
          }) => {
            if (payload && payload.device) {
              if (payload.type === "video") {
                console.log("receiving video payload:");
                console.log(payload);
                if (selectedVideoDevice?.index !== payload.device.index) {
                  setSelectedVideoDevice(payload.device);
                }
              }

              if (payload.type === "audio") {
                console.log("receiving audio payload:");
                console.log(payload);
                if (selectedAudioDevice?.index !== payload.device.index) {
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
        isRecording,
        setIsRecording,
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
