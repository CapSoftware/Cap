import {
  createMutation,
  createQuery,
  queryOptions,
} from "@tanstack/solid-query";

import { commands, RecordingOptions } from "./tauri";
import { createQueryInvalidate } from "./events";
import { createStore, reconcile } from "solid-js/store";
import { createEffect, createMemo } from "solid-js";
import { makePersisted } from "@solid-primitives/storage";
import { FPS } from "~/routes/editor/context";
import { authStore, generalSettingsStore } from "~/store";
import { setApplicationMode } from "~/components/Mode";

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

type PartialRecordingOptions = Omit<RecordingOptions, "captureTarget">;
export function createOptionsQuery() {
  const [state, setState] = makePersisted(
    createStore<PartialRecordingOptions>({
      cameraLabel: null,
      audioInputName: null,
      mode: "studio",
    }),
    { name: "recordingOptionsQuery" }
  );

  const setOptions = createMutation(() => ({
    mutationFn: async (newOptions: RecordingOptions) => {
      // Capture current mode
      const prevMode = state.mode;
      // Update backend first
      await commands.setRecordingOptions(newOptions);
      // Extract options minus target
      const { captureTarget: _, ...partialOptions } = newOptions;
      
      // If mode changed, update global app mode state
      if (prevMode !== partialOptions.mode && partialOptions.mode) {
        // This will trigger UI updates immediately
        setApplicationMode(partialOptions.mode);
      }
      
      // Update persisted state
      setState(partialOptions);
      
      // Force a refetch to ensure everything is in sync
      return commands.getRecordingOptions();
    },
  }));

  const options = createQuery(() => ({
    ...getOptions,
    select: (data) => {
      const ret = { ...data };

      if (state.cameraLabel) ret.cameraLabel = state.cameraLabel;
      if (state.audioInputName) ret.audioInputName = state.audioInputName;
      if (state.mode) ret.mode = state.mode;
      
      // If we have a mode from backend that differs from our store, update global app mode
      if (data.mode && state.mode !== data.mode) {
        setApplicationMode(data.mode);
      }

      setState(ret);
      return ret;
    },
  }));

  createQueryInvalidate(options, "recordingOptionsChanged");

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
