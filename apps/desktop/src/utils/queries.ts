import { createEventListener } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import {
	createQuery,
	queryOptions,
	useMutation,
	useQuery,
} from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createMemo } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { useRecordingOptions } from "~/routes/(window-chrome)/OptionsContext";
import {
	authStore,
	generalSettingsStore,
	recordingSettingsStore,
} from "~/store";
import { createQueryInvalidate } from "./events";
import {
	type CameraInfo,
	commands,
	type DeviceOrModelID,
	type RecordingMode,
	type ScreenCaptureTarget,
} from "./tauri";
import { orgCustomDomainClient, protectedHeaders } from "./web-api";

export const listWindows = queryOptions({
	queryKey: ["capture", "windows"] as const,
	queryFn: async () => {
		const w = await commands.listCaptureWindows();

		w.sort(
			(a, b) =>
				a.owner_name.localeCompare(b.owner_name) ||
				a.name.localeCompare(b.name),
		);

		return w;
	},
	reconcile: "id",
	refetchInterval: false,
});

export const listScreens = queryOptions({
	queryKey: ["capture", "displays"] as const,
	queryFn: () => commands.listCaptureDisplays(),
	reconcile: "id",
	refetchInterval: 1000,
});

export const listWindowsWithThumbnails = queryOptions({
	queryKey: ["capture", "windows-thumbnails"] as const,
	queryFn: async () => {
		const w = await commands.listWindowsWithThumbnails();

		w.sort(
			(a, b) =>
				a.owner_name.localeCompare(b.owner_name) ||
				a.name.localeCompare(b.name),
		);

		return w;
	},
	reconcile: "id",
	refetchInterval: false,
});

export const listDisplaysWithThumbnails = queryOptions({
	queryKey: ["capture", "displays-thumbnails"] as const,
	queryFn: () => commands.listDisplaysWithThumbnails(),
	reconcile: "id",
	refetchInterval: 1000,
});

const getCurrentRecording = queryOptions({
	queryKey: ["currentRecording"] as const,
	queryFn: () => commands.getCurrentRecording().then((d) => d[0]),
});

export const listVideoDevices = queryOptions({
	queryKey: ["videoDevices"] as const,
	queryFn: () => commands.listCameras(),
	refetchInterval: 1000,
	initialData: [],
});

export function createVideoDevicesQuery() {
	const query = createQuery(() => listVideoDevices);

	const [videoDevicesStore, setVideoDevices] = createStore<CameraInfo[]>([]);

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
	const PERSIST_KEY = "recording-options-query-2";
	const [_state, _setState] = createStore<{
		captureTarget: ScreenCaptureTarget;
		micName: string | null;
		mode: RecordingMode;
		captureSystemAudio?: boolean;
		targetMode?: "display" | "window" | "area" | null;
		cameraID?: DeviceOrModelID | null;
		/** @deprecated */
		cameraLabel: string | null;
	}>({
		captureTarget: { variant: "display", id: "0" },
		micName: null,
		cameraLabel: null,
		mode: "studio",
	});

	createEventListener(window, "storage", (e) => {
		if (e.key === PERSIST_KEY) _setState(JSON.parse(e.newValue ?? "{}"));
	});

	createEffect(() => {
		recordingSettingsStore.set({
			target: _state.captureTarget,
			micName: _state.micName,
			cameraId: _state.cameraID,
			mode: _state.mode,
			systemAudio: _state.captureSystemAudio,
		});
	});

	const [state, setState] = makePersisted([_state, _setState], {
		name: PERSIST_KEY,
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
		queryKey: ["licenseQuery"],
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
	const { setOptions, rawOptions } = useRecordingOptions();

	const rawMutate = async (model: DeviceOrModelID | null) => {
		const before = rawOptions.cameraID ? { ...rawOptions.cameraID } : null;
		setOptions("cameraID", reconcile(model));
		if (model) {
			await commands.showWindow("Camera");
			getCurrentWindow().setFocus();
		}

		await commands.setCameraInput(model).catch(async (e) => {
			if (JSON.stringify(before) === JSON.stringify(model) || !before) {
				setOptions("cameraID", null);
			} else setOptions("cameraID", reconcile(before));

			throw e;
		});
	};

	const setCameraInput = useMutation(() => ({
		mutationFn: rawMutate,
	}));

	return new Proxy(
		setCameraInput as typeof setCameraInput & { rawMutate: typeof rawMutate },
		{
			get(target, key) {
				if (key === "rawMutate") return rawMutate;
				return Reflect.get(target, key);
			},
		},
	);
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
