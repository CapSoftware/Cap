import { createQuery, queryOptions } from "@tanstack/solid-query";
import { createTimer } from "@solid-primitives/timer";

import { commands } from "./tauri";
import { createQueryInvalidate } from "./events";

export const getWindows = queryOptions({
  queryKey: ["capture", "windows"] as const,
  queryFn: () => commands.listCaptureWindows(),
  reconcile: "id",
});

const getOptions = queryOptions({
  queryKey: ["recordingOptions"] as const,
  queryFn: async () => {
    const o = await commands.getRecordingOptions();
    if (o.status === "ok") return o.data;
  },
});

const getCurrentRecording = queryOptions({
  queryKey: ["currentRecording"] as const,
  queryFn: async () => {
    const o = await commands.getCurrentRecording();
    if (o.status === "ok") return o.data[0];
  },
});

export const listAudioDevices = queryOptions({
  queryKey: ["audioDevices"] as const,
  queryFn: async () => {
    const r = await commands.listAudioDevices();
    if (r.status === "ok") return r.data.map((name) => ({ name }));
  },
  reconcile: "name",
});

export function createOptionsQuery() {
  const options = createQuery(() => getOptions);
  createQueryInvalidate(options, "recordingOptionsChanged");

  return options;
}

export function createWindowsQuery() {
  const windows = createQuery(() => getWindows);
  createTimer(() => windows.refetch(), 1000, setInterval);

  return windows;
}

export function createAudioDevicesQuery() {
  const devices = createQuery(() => listAudioDevices);
  createTimer(() => devices.refetch(), 1000, setInterval);

  return devices;
}
export function createCurrentRecordingQuery() {
  const currentRecording = createQuery(() => getCurrentRecording);
  createQueryInvalidate(currentRecording, "currentRecordingChanged");

  return currentRecording;
}
