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
    if (!getDevicesCalled.current) {
      getDevices();
      getDevicesCalled.current = true;
    }
  }, []);

  const changeDevice = (type: "video" | "audio", device: Devices) => {
    console.log(`Change-device recieved, previous selected: audio: ${selectedAudioDevice?.index}  vid: ${selectedVideoDevice?.index}`);

    if (type && device) {
      if (window.fathom !== undefined) {
        window.fathom.trackEvent(`${type}_device_change`);
      }
      if (type === "video") {
        import("@tauri-apps/api/window").then(({ WebviewWindow }) => {
          if (WebviewWindow.getByLabel("camera")) {
            WebviewWindow.getByLabel("camera").close();
          } else {
            initializeCameraWindow();
          }
        });
        if (selectedVideoDevice?.index !== device.index) {
          setSelectedVideoDevice(device);
        }
      }

      if (type === "audio") {
        if (selectedAudioDevice?.index !== device.index) {
          setSelectedAudioDevice(device);
        }
      }
    }
  }

  useEffect(() => {
    let unlistenChangeDevice: any;
    let unlistenTraySetDevice: any;

    const setupChangeDeviceListener = async () => {
      try {
        unlistenChangeDevice = await listen(
          "change-device",
          ({
            payload,
          }: {
            payload: { type: "video" | "audio"; device: Devices };
          }) => {
            changeDevice(payload.type, payload.device); 
          }
        );
      } catch (error) {
        console.error("Error setting up listener:", error);
      }
    };

    const createNonDevice = (kind: "videoinput" | "audioinput") => {
      return { 
        index: -1,
        label: "None",
        kind: kind,
        deviceId: "none",
      } as Devices;
    }

    const setupTraySetDeviceListener = async () => {
      unlistenTraySetDevice = await listen<{type: string, id: string}>("tray_set_device", (event) => {
        const id = event.payload.id;
        const option = event.payload.type as "videoinput" | "audioinput";
        const newDevice = id === "none" ? createNonDevice(option) :
          devices.find((device) => option === device.kind && event.payload.id === device.deviceId);

        console.log(`Trying to set ${newDevice?.label} from ${newDevice?.kind === "videoinput" ? selectedVideoDevice?.label : selectedAudioDevice?.label}`)

        changeDevice(event.payload.type === "videoinput" ? "video" : "audio", newDevice);
      });
    };

    setupChangeDeviceListener();
    setupTraySetDeviceListener();

    if (devices.length !== 0) {
      emit("media-devices-set", {
        mediaDevices: [
          createNonDevice("videoinput"),
          createNonDevice("audioinput"),
          ...(devices as Omit<Devices, 'index'>[])
        ],
        selectedVideo: selectedVideoDevice?.label === "None" ? createNonDevice("videoinput") : selectedVideoDevice,
        selectedAudio: selectedAudioDevice?.label === "None" ? createNonDevice("audioinput") :  selectedAudioDevice,
      });
    }

    return () => {
      if (unlistenChangeDevice) {
        unlistenChangeDevice();
      }
      if (unlistenTraySetDevice) {
        unlistenTraySetDevice();
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
