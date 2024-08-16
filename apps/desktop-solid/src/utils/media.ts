import { createTimer } from "@solid-primitives/timer";
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
    await navigator.mediaDevices.getUserMedia({ video: true });
    return await navigator.mediaDevices.enumerateDevices();
  });

  onMount(() => {
    navigator.mediaDevices.addEventListener("devicechange", refetch);
    onCleanup(() =>
      navigator.mediaDevices.removeEventListener("devicechange", refetch)
    );
  });

  return () => devices.latest ?? [];
}

export function createCameras() {
  const devices = createDevices();

  const [rustCameras, { refetch }] = createResource(() =>
    commands.getCameras()
  );

  createTimer(refetch, 5 * 1000, setInterval);
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
    return camera;
  };
}
