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
  refetchInterval: 1000
});

export const permissions = queryOptions({
  queryKey: ["permissionsOS"] as const,
  queryFn: async () => {
    const result = await commands.doPermissionsCheck(true)
    return result
  },
  refetchInterval: 1000,
})

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

  return devices;
}

export function createVideoDevicesQuery() {
  const permissions = createPermissionsQuery()
  const options = () => queryOptions({
    queryKey: ["videoDevices"] as const,
    queryFn: async () => {
      await navigator.mediaDevices.getUserMedia({ video: true });
      const browserDevices = await navigator.mediaDevices.enumerateDevices();
      const rustCameras = await commands.listCameras();
      return browserDevices.filter(device => device.kind === "videoinput"
        && rustCameras.some(rDevice => rDevice === device.label)
      )
    },
    initialData: [],
    reconcile: (oldData, newData) => permissions?.data?.camera === 'granted' ? newData
      : Array.isArray(oldData) && oldData.length === 0 ? oldData : [],
    refetchOnWindowFocus: "always",
    enabled: permissions.data?.camera === 'granted',
  })
  const devices = createQuery(options);

  return devices;
}

export function createCurrentRecordingQuery() {
  const currentRecording = createQuery(() => getCurrentRecording);
  createQueryInvalidate(currentRecording, "currentRecordingChanged");

  return currentRecording;
}

export function createPermissionsQuery() {
  const permission = createQuery(() => permissions);

  return permission;
}
