"use client";

import {
  useState,
  createContext,
  useContext,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getLocalDevices, enumerateAndStoreDevices } from "./utils";

export interface Devices {
  index: number;
  label: string;
  kind: "videoinput" | "audioinput";
  deviceId: string;
}

export interface MediaDeviceContextData {
  selectedVideoDevice: Devices | null;
  setSelectedVideoDevice: React.Dispatch<React.SetStateAction<Devices | null>>;
  selectedAudioDevice: Devices | null;
  setSelectedAudioDevice: React.Dispatch<React.SetStateAction<Devices | null>>;
  selectedDisplayType: "screen" | "window" | "area";
  setSelectedDisplayType: React.Dispatch<
    React.SetStateAction<"screen" | "window" | "area">
  >;
  devices: Devices[];
  getDevices: () => Promise<void>;
  isRecording: boolean;
  setIsRecording: React.Dispatch<React.SetStateAction<boolean>>;
  startingRecording: boolean;
  setStartingRecording: React.Dispatch<React.SetStateAction<boolean>>;
  updateTrigger: number;
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
  const [selectedDisplayType, setSelectedDisplayType] = useState<
    "screen" | "window" | "area"
  >("screen");
  const [devices, setDevices] = useState<Devices[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [startingRecording, setStartingRecording] = useState(false);
  const sharedStream = useRef<MediaStream | null>(null);
  const [updateTrigger, setUpdateTrigger] = useState(0);

  const updateSharedStream = useCallback((newStream: MediaStream | null) => {
    sharedStream.current = newStream;
    setUpdateTrigger((prev) => prev + 1);
  }, []);

  const getDevices = useCallback(async () => {
    await enumerateAndStoreDevices();

    try {
      const { videoDevices, audioDevices } = await getLocalDevices();

      const formattedDevices = [
        ...(videoDevices.map((device: MediaDeviceInfo, index) => ({
          index: index,
          label: device.label,
          kind: "videoinput",
          deviceId: device.deviceId,
        })) as Devices[]),
        ...(audioDevices.map((device: MediaDeviceInfo, index: number) => ({
          index: index,
          label: device.label,
          kind: "audioinput",
          deviceId: device.deviceId,
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
        selectedDisplayType,
        setSelectedDisplayType,
        devices,
        getDevices,
        isRecording,
        setIsRecording,
        startingRecording,
        setStartingRecording,
        // sharedStream: sharedStream.current,
        // startSharedStream,
        // stopSharedStream,
        updateTrigger,
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
