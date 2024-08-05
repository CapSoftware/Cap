"use client";

import {
  useState,
  createContext,
  useContext,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  getLocalDevices,
  enumerateAndStoreDevices,
  initializeCameraWindow,
} from "./utils";
import { commands } from "../commands";
import { setTrayMenu } from "../tray";

export type DeviceKind = "videoinput" | "audioinput";
export interface Device {
  index: number;
  id: string;
  label: string;
  kind: DeviceKind;
}

export interface MediaDeviceContextData {
  selectedVideoDevice: Device | null;
  setSelectedVideoDevice: React.Dispatch<React.SetStateAction<Device | null>>;
  selectedAudioDevice: Device | null;
  setSelectedAudioDevice: React.Dispatch<React.SetStateAction<Device | null>>;
  selectedDisplayType: "screen" | "window" | "area";
  setSelectedDisplayType: React.Dispatch<
    React.SetStateAction<"screen" | "window" | "area">
  >;
  devices: Device[];
  getDevices: () => Promise<void>;
  isRecording: boolean;
  setIsRecording: React.Dispatch<React.SetStateAction<boolean>>;
  startingRecording: boolean;
  setStartingRecording: React.Dispatch<React.SetStateAction<boolean>>;
}

export const MediaDeviceContext = createContext<
  MediaDeviceContextData | undefined
>(undefined);

export const MediaDeviceProvider: React.FC<React.PropsWithChildren<{}>> = ({
  children,
}) => {
  const [selectedVideoDevice, setSelectedVideoDevice] = useState<Device | null>(
    null
  );
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<Device | null>(
    null
  );
  const [selectedDisplayType, setSelectedDisplayType] = useState<
    "screen" | "window" | "area"
  >("screen");
  const [devices, setDevices] = useState<Device[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [startingRecording, setStartingRecording] = useState(false);
  const getDevicesCalled = useRef(false);
  const tauriWindowImport = import("@tauri-apps/api/window");

  const getDevices = useCallback(async () => {
    await enumerateAndStoreDevices();

    try {
      const { videoDevices, audioDevices } = await getLocalDevices();

      const formattedDevices = [
        ...(videoDevices.map((device: MediaDeviceInfo, index) => ({
          index: index,
          label: device.label,
          kind: "videoinput",
          id: device.deviceId,
        })) as Device[]),
        ...(audioDevices.map((device: MediaDeviceInfo, index: number) => ({
          index: index,
          label: device.label,
          kind: "audioinput",
          id: device.deviceId ? device.deviceId : device.label,
        })) as Device[]),
      ];

      setDevices(formattedDevices);

      // Automatically select the first available devices if not already selected
      if (!selectedVideoDevice) {
        const storedVideoDevice = localStorage.getItem("selected-videoinput");
        let videoDevice: Device | null = null;
        if (storedVideoDevice && storedVideoDevice !== "none") {
          videoDevice = formattedDevices.find(
            (device) =>
              device.kind === "videoinput" && device.label === storedVideoDevice
          );
        }
        setSelectedVideoDevice(videoDevice);
      }

      if (!selectedAudioDevice) {
        const storedAudioDevice = localStorage.getItem("selected-audioinput");
        let audioDevice: Device | null = null;
        if (storedAudioDevice && storedAudioDevice !== "none") {
          audioDevice = formattedDevices.find(
            (device) =>
              device.kind === "audioinput" && device.label === storedAudioDevice
          );
        }
        setSelectedAudioDevice(audioDevice);
      }
    } catch (error) {
      console.error("Failed to get media devices:", error);
    }
  }, [selectedVideoDevice, selectedAudioDevice]);

  useEffect(() => {
    if (!getDevicesCalled.current) {
      getDevices();
      getDevicesCalled.current = true;
    }
  }, []);

  const updateSelectedDevice = (kind: DeviceKind, device: Device | null) => {
    if (!kind) {
      return;
    }

    if (typeof window === "undefined") return;

    if (window.fathom !== undefined) {
      window.fathom.trackEvent(
        `${kind === "videoinput" ? "video" : "audio"}_device_change`
      );
    }
    if (kind === "videoinput") {
      if (device?.label !== selectedVideoDevice?.label) {
        const previous = selectedVideoDevice;
        setSelectedVideoDevice(device);
        localStorage.setItem("selected-videoinput", device?.label || "none");
        if (!device) {
          commands.closeWebview("camera");
        } else if (!previous && device) {
          initializeCameraWindow();
        }
      }
    }

    if (kind === "audioinput") {
      if (device?.label !== selectedAudioDevice?.label) {
        setSelectedAudioDevice(device);
        localStorage.setItem("selected-audioinput", device?.label || "none");
      }
    }
  };

  useEffect(() => {
    let unlisten: any;
    const setup = async () => {
      try {
        unlisten = await listen<{
          type: string;
          device: Device | null;
        }>("cap://av/set-device", (event) => {
          updateSelectedDevice(
            event.payload.type as DeviceKind,
            event.payload.device
          );
        });
      } catch (error) {
        console.error("Error setting up change-device listener:", error);
      }
    };

    setup();
    return () => {
      unlisten?.();
    };
  });

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
