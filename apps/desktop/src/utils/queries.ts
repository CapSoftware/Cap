import { makePersisted } from "@solid-primitives/storage";
import {
  createMutation,
  createQuery,
  queryOptions,
  useQuery,
} from "@tanstack/solid-query";
import { createMemo } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import { createEventListener } from "@solid-primitives/event-listener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useRecordingOptions } from "~/routes/(window-chrome)/OptionsContext";
import { authStore, generalSettingsStore } from "~/store";
import { createQueryInvalidate } from "./events";
import { commands, RecordingMode, ScreenCaptureTarget } from "./tauri";
import { orgCustomDomainClient, protectedHeaders } from "./web-api";

export const listWindows = queryOptions({
  queryKey: ["capture", "windows"] as const,
  queryFn: async () => {
    const w = await commands.listCaptureWindows();

    w.sort(
      (a, b) =>
        a.owner_name.localeCompare(b.owner_name) || a.name.localeCompare(b.name)
    );

    return w;
  },
  reconcile: "id",
  refetchInterval: 1000,
});

export const listScreens = queryOptions({
  queryKey: ["capture", "screens"] as const,
  queryFn: () => commands.listCaptureScreens(),
  reconcile: "id",
  refetchInterval: 1000,
});

const getCurrentRecording = queryOptions({
  queryKey: ["currentRecording"] as const,
  queryFn: () => commands.getCurrentRecording().then((d) => d[0]),
});

const listVideoDevices = queryOptions({
  queryKey: ["videoDevices"] as const,
  queryFn: () => commands.listCameras(),
  refetchInterval: 1000,
  initialData: [],
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
  queryFn: () => commands.listAudioDevices(),
  reconcile: "name",
  refetchInterval: 1000,
  gcTime: 0,
  staleTime: 0,
});

export const getPermissions = queryOptions({
  queryKey: ["permissionsOS"] as const,
  queryFn: () => commands.doPermissionsCheck(true),
  refetchInterval: 1000,
});

export function createOptionsQuery() {
  const PERSIST_KEY = "recording-options-query";
  const [state, setState] = makePersisted(
    createStore<{
      captureTarget: ScreenCaptureTarget;
      micName: string | null;
      cameraLabel: string | null;
      mode: RecordingMode;
      captureSystemAudio?: boolean;
    }>({
      captureTarget: { variant: "screen", id: 0 },
      micName: null,
      cameraLabel: null,
      mode: "studio",
    }),
    { name: PERSIST_KEY }
  );

  createEventListener(window, "storage", (e) => {
    console.log(e);
    if (e.key === PERSIST_KEY) setState(JSON.parse(e.newValue ?? "{}"));
  });

  return { rawOptions: state, setOptions: setState };
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

export function createCameraMutation() {
  const { setOptions } = useRecordingOptions();

  const setCameraInput = createMutation(() => ({
    mutationFn: async (label: string | null) => {
      setOptions("cameraLabel", label);
      if (label) {
        await commands.showWindow("Camera");
        getCurrentWindow().setFocus();
      }
      await commands.setCameraInput(label);
    },
  }));

  return setCameraInput;
}

export function createCustomDomainQuery() {
  return useQuery(() => ({
    queryKey: ["customDomain"] as const,
    queryFn: async () => {
      try {
        const auth = await authStore.get();
        if (!auth) return { custom_domain: null, domain_verified: null };
        const response = await orgCustomDomainClient.getOrgCustomDomain({
          headers: await protectedHeaders(),
        });
        if (response.status === 200) return response.body;
      } catch (error) {
        console.error("Error fetching custom domain:", error);
        return { custom_domain: null, domain_verified: null };
      }
    },
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  }));
}
