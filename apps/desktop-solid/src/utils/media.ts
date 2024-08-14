import { type Accessor, createResource, onCleanup } from "solid-js";

export function createDevices() {
  const [devices, { refetch }] = createResource(async () => {
    await navigator.mediaDevices.getUserMedia({ video: true });
    return await navigator.mediaDevices.enumerateDevices();
  });

  navigator.mediaDevices.addEventListener("devicechange", refetch);
  onCleanup(() =>
    navigator.mediaDevices.removeEventListener("devicechange", refetch)
  );

  return () => devices.latest ?? [];
}

export function createCameras() {
  const devices = createDevices();

  return () => devices().filter((device) => device.kind === "videoinput");
}

export function createCameraForLabel(label: Accessor<string>) {
  const cameras = createCameras();

  return () => {
    const camera = cameras().find((camera) => camera.label === label());
    return camera;
  };
}
