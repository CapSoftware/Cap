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
  const [selectedVideoDevice, setSelectedVideoDevice] =
    useState<Device | null>(null);
  const [selectedAudioDevice, setSelectedAudioDevice] =
    useState<Device | null>(null);
  const [selectedDisplayType, setSelectedDisplayType] = useState<
    "screen" | "window" | "area"
  >("screen");
  const [devices, setDevices] = useState<Device[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [startingRecording, setStartingRecording] = useState(false);
  const getDevicesCalled = useRef(false);

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
    if (!getDevicesCalled.current) {
      getDevices();
      getDevicesCalled.current = true;
    }
  }, []);

  const updateSelectedDevice = (type: DeviceKind, device: Device | null) => {
    if (!type) {
      return;
    }
    if (window.fathom !== undefined) {
      window.fathom.trackEvent(`${type === "videoinput" ? "video" : "audio"}_device_change`);
    }
    if (type === "videoinput") {
      import("@tauri-apps/api/window").then(({ WebviewWindow }) => {
        if (WebviewWindow.getByLabel("camera")) {
          WebviewWindow.getByLabel("camera").close();
        } else if (type === "videoinput" && device) {
          initializeCameraWindow();
        }
      });
      
      if ((!device && selectedVideoDevice) || (selectedVideoDevice?.index !== device?.index)) {
        setSelectedVideoDevice(device);
      }
    }

    if (type === "audioinput") {
      if ((!device && selectedAudioDevice) || (selectedAudioDevice?.index !== device?.index)) {
        setSelectedAudioDevice(device);
      }
    }
  }

  useEffect(() => {
    let unlistenFnChangeDevice: any;
    let unlistenFnTraySetDevice: any;

    const setupListeners = async () => {
      try {
        unlistenFnChangeDevice = await listen<{ type: string, device: Device | null }>("change-device", (event) => {
          updateSelectedDevice(event.payload.type as DeviceKind, event.payload.device);
        });
      } catch (error) {
        console.error("Error setting up change-device listener:", error);
      }

      try {
        unlistenFnTraySetDevice = await listen<{ type: string, id: string | null }>("tray-set-device-id", (event) => {
          const id = event.payload.id;
          const kind = event.payload.type as DeviceKind;
          const newDevice = id ? devices.find((device) => kind === device.kind && id === device.id) : null;
          updateSelectedDevice(kind, newDevice);
        });
      } catch (error) {
        console.error("Error setting up tray-set-device-id listener:", error);
      }
    };

    setupListeners();

    if (devices.length !== 0) {
      emit("media-devices-set", {
        mediaDevices: [
          ...(devices as Omit<Device, 'index'>[])
        ],
        selectedVideo: selectedVideoDevice,
        selectedAudio: selectedAudioDevice,
      });
    }

    return () => {
      if (unlistenFnChangeDevice) {
        unlistenFnChangeDevice();
      }
      if (unlistenFnTraySetDevice) {
        unlistenFnTraySetDevice();
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
