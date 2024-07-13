"use client";

import * as commands from "@/utils/commands";

export const enumerateAndStoreDevices = async () => {
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    await navigator.mediaDevices.getUserMedia({
      video: true,
    });
    const video = await navigator.mediaDevices.enumerateDevices();
    const audio: string[] = await commands.enumerateAudioDevices();
    const videoDevices = video.filter((device) => device.kind === "videoinput");
    const audioDevices = audio.map((device) => {
      return {
        id: device,
        label: device,
        kind: "audioinput",
      };
    });

    window.localStorage.setItem("audioDevices", JSON.stringify(audioDevices));
    window.localStorage.setItem("videoDevices", JSON.stringify(videoDevices));
  }
};

export const getLocalDevices = async () => {
  if (typeof window === "undefined") {
    return { audioDevices: [], videoDevices: [] };
  }

  const videoDevices = JSON.parse(
    window.localStorage.getItem("videoDevices") || "[]"
  ) as MediaDeviceInfo[];

  const audioDevices = JSON.parse(
    window.localStorage.getItem("audioDevices") || "[]"
  ) as MediaDeviceInfo[];

  return { audioDevices, videoDevices };
};

export const getSelectedVideoProperties = async () => {
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    const videoDeviceProperties = JSON.parse(
      window.localStorage.getItem("videoDeviceProperties") || "{}"
    );

    return videoDeviceProperties;
  }
};

export const initializeCameraWindow = async () => {
  if (typeof window === "undefined") return;
  import("@tauri-apps/api/window").then(({ currentMonitor, WebviewWindow }) => {
    currentMonitor().then((monitor) => {
      const windowWidth = 230;
      const windowHeight = 230;

      if (monitor && monitor.size) {
        const scalingFactor = monitor.scaleFactor;
        const x = 100;
        const y = monitor.size.height / scalingFactor - windowHeight - 100;

        const existingCameraWindow = WebviewWindow.getByLabel("camera");
        if (existingCameraWindow) {
          console.log("Camera window already open.");
          existingCameraWindow.close();
        } else {
          new WebviewWindow("camera", {
            url: "/camera",
            title: "Cap Camera",
            width: windowWidth,
            height: windowHeight,
            x: x / scalingFactor,
            y: y,
            maximized: false,
            resizable: false,
            fullscreen: false,
            transparent: true,
            decorations: false,
            alwaysOnTop: true,
            center: false,
          });
        }
      }
    });
  });
};
