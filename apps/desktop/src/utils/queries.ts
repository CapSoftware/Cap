import { createQuery, queryOptions } from "@tanstack/solid-query";
import { createTimer } from "@solid-primitives/timer";

import { commands } from "./tauri";
import { createQueryInvalidate } from "./events";
import { createStore, reconcile } from "solid-js/store";
import { createMemo } from "solid-js";

export const listWindows = queryOptions({
  queryKey: ["capture", "windows"] as const,
  queryFn: () => commands.listCaptureWindows(),
  reconcile: "id",
  refetchInterval: 1000,
});

export const listScreens = queryOptions({
  queryKey: ["capture", "screens"] as const,
  queryFn: () => commands.listCaptureScreens(),
  reconcile: "id",
  refetchInterval: 1000,
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

const listVideoDevices = queryOptions({
  queryKey: ["videoDevices"] as const,
  queryFn: () => commands.listCameras(),
  refetchInterval: 1000,
});

export function createVideoDevicesQuery() {
  const query = createQuery(() => listVideoDevices);

  const [videoDevicesStore, setVideoDevices] = createStore<string[]>([]);

  createMemo(() => {
    setVideoDevices(reconcile(query.data ?? []));
  });

  return videoDevicesStore;
}

export const listAudioDevices = queryOptions({
  queryKey: ["audioDevices"] as const,
  queryFn: async () => {
    const r = await commands.listAudioDevices();
    if (r.status === "ok")
      return r.data.map((name) => ({ name, deviceId: name }));
  },
  reconcile: "name",
  refetchInterval: 1000,
});

export const getPermissions = queryOptions({
  queryKey: ["permissionsOS"] as const,
  queryFn: () => commands.doPermissionsCheck(true),
  refetchInterval: 1000,
});

export function createOptionsQuery() {
  const options = createQuery(() => getOptions);
  createQueryInvalidate(options, "recordingOptionsChanged");

  return options;
}

export function createCurrentRecordingQuery() {
  const currentRecording = createQuery(() => getCurrentRecording);
  createQueryInvalidate(currentRecording, "currentRecordingChanged");

  return currentRecording;
}
