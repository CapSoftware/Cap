import {
  createMutation,
  createQuery,
  queryOptions,
} from "@tanstack/solid-query";

import { commands, events, RecordingOptions } from "./tauri";
import { createQueryInvalidate } from "./events";
import { createStore, reconcile } from "solid-js/store";
import { createEffect, createMemo, createSignal, onMount } from "solid-js";
import { makePersisted } from "@solid-primitives/storage";
import { FPS } from "~/routes/editor/context";
import { authStore, generalSettingsStore } from "~/store";

function debugFetch<T>(name: string, doFetch: () => Promise<T>) {
  return () => {
    // console.log(`fetching '${name}'`);
    return doFetch()
      .then((s) => {
        // console.log(`fetched '${name}'`);
        return s;
      })
      .catch((e) => {
        // console.log(`failed to fetch '${name}'`);
        throw e;
      });
  };
}

export const listWindows = queryOptions({
  queryKey: ["capture", "windows"] as const,
  queryFn: debugFetch("captureWindows", () => commands.listCaptureWindows()),
  reconcile: "id",
  refetchInterval: 1000,
});

export const listScreens = queryOptions({
  queryKey: ["capture", "screens"] as const,
  queryFn: debugFetch("captureScreens", () => commands.listCaptureScreens()),
  reconcile: "id",
  refetchInterval: 1000,
});

const getOptions = queryOptions({
  queryKey: ["recordingOptions"] as const,
  queryFn: debugFetch("recordingOptions", () => commands.getRecordingOptions()),
});

const getCurrentRecording = queryOptions({
  queryKey: ["currentRecording"] as const,
  queryFn: debugFetch("recordingOptions", () =>
    commands.getCurrentRecording().then((d) => d[0])
  ),
});

const listVideoDevices = queryOptions({
  queryKey: ["videoDevices"] as const,
  queryFn: debugFetch("recordingOptions", () => commands.listCameras()),
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
  queryFn: debugFetch("audioDevices", async () => {
    const devices = await commands.listAudioDevices();
    return devices.map((name) => ({ name, deviceId: name }));
  }),
  reconcile: "name",
  refetchInterval: 1000,
  gcTime: 0,
  staleTime: 0,
});

export const getPermissions = queryOptions({
  queryKey: ["permissionsOS"] as const,
  queryFn: debugFetch("permissions", () => commands.doPermissionsCheck(true)),
  refetchInterval: 1000,
});

export function createOptionsQuery() {
  const [state, setState] = makePersisted(
    createSignal<RecordingOptions | null>(),
    { name: "recording-options-query" }
  );

  const setOptions = createMutation(() => ({
    mutationFn: async (newOptions: RecordingOptions) => {
      await commands.setRecordingOptions(newOptions);
    },
  }));

  const initialData = state() ?? undefined;
  const options = createQuery<RecordingOptions>(() => ({
    ...getOptions,
    ...(initialData === undefined
      ? { initialData, staleTime: 1000 }
      : ({} as any)),
    select: (data) => {
      setState(data);

      return data;
    },
  }));

  createQueryInvalidate(options, "recordingOptionsChanged");

  events.recordingOptionsChanged.listen(() => {
    commands.getRecordingOptions().then((options) => {
      console.log("setting state", options);
      setState(options);
    });
  });

  return { options, setOptions };
}

export function createCurrentRecordingQuery() {
  const currentRecording = createQuery(() => getCurrentRecording);

  createQueryInvalidate(currentRecording, "currentRecordingChanged");

  return currentRecording;
}

export function createLicenseQuery() {
  const query = createQuery(() => ({
    queryKey: ["bruh"],
    queryFn: async () => {
      const settings = await generalSettingsStore.get();
      const auth = await authStore.get();

      if (auth?.plan?.upgraded) return { type: "pro" as const, ...auth.plan };
      if (settings?.commercialLicense)
        return {
          type: "commercial" as const,
          ...settings.commercialLicense,
          instanceId: settings.instanceId,
        };
      return { type: "personal" as const };
    },
  }));

  generalSettingsStore.listen(() => query.refetch());
  authStore.listen(() => query.refetch());

  return query;
}
