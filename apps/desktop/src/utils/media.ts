import {
  type Accessor,
  createEffect,
  createResource,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { commands } from "./tauri";

export function createDevices() {
  const [devices, { refetch }] = createResource(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      return await navigator.mediaDevices.enumerateDevices();
    } catch (error) {
      console.error("Error accessing media devices:", error);
      return [];
    }
  });

  onMount(() => {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener("devicechange", refetch);
      onCleanup(() =>
        navigator.mediaDevices.removeEventListener("devicechange", refetch)
      );
    }
  });

  return () => devices.latest ?? [];
}

export function createCameras() {
  const devices = createDevices();

  const [rustCameras, { refetch }] = createResource(async () => {
    try {
      return await commands.listCameras();
    } catch (error) {
      console.error("Error listing cameras:", error);
      return [];
    }
  });

  createEffect(on(devices, refetch));

  return () => {
    const videoDevices = devices().filter(
      (device) => device.kind === "videoinput"
    );

    const cameras = rustCameras.latest ?? [];

    return videoDevices.filter((device) =>
      cameras.some((c) => c === device.label)
    );
  };
}

export function createCameraForLabel(label: Accessor<string>) {
  const cameras = createCameras();

  return () => {
    const camera = cameras().find((camera) => camera.label === label());
    return camera || null;
  };
}

export async function stopMediaStream(kind: "audio" | "video" | "both") {
  const streams = await navigator.mediaDevices.getUserMedia({
    audio: kind === "audio" || kind === "both",
    video: kind === "video" || kind === "both",
  });

  streams.getTracks().forEach((track) => {
    if ((kind === "audio" && track.kind === "audio") ||
        (kind === "video" && track.kind === "video") ||
        kind === "both") {
      track.stop();
    }
  });
}
