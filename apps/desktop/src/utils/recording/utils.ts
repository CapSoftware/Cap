"use client";

import { invoke } from "@tauri-apps/api/tauri";

export const enumerateAndStoreDevices = async () => {
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    await navigator.mediaDevices.getUserMedia({
      video: true,
    });
    const video = await navigator.mediaDevices.enumerateDevices();
    const audio: string[] = await invoke("enumerate_audio_devices");
    const videoDevices = video.filter((device) => device.kind === "videoinput");
    const audioDevices = audio.map((device) => {
      return {
        deviceId: device,
        groupId: "",
        kind: "audioinput",
        label: device,
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
