import { createEventListener } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import {
	createQuery,
	queryOptions,
	useMutation,
	useQuery,
} from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { batch, createEffect, createMemo, onCleanup } from "solid-js";
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
	type RecordingTargetMode,
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
	refetchInterval: 10_000,
	staleTime: 5_000,
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
	refetchInterval: 10_000,
	staleTime: 5_000,
});

const getCurrentRecording = queryOptions({
	queryKey: ["currentRecording"] as const,
	queryFn: () => commands.getCurrentRecording().then((d) => d[0]),
	staleTime: 0,
});

export const listRecordings = queryOptions({
	queryKey: ["recordings"] as const,
	queryFn: async () => {
		return await commands.listRecordings();
	},
	initialData: [],
});

export const listVideoDevices = queryOptions({
	queryKey: ["videoDevices"] as const,
	queryFn: () => commands.listCameras(),
	refetchInterval: 5_000,
	staleTime: 3_000,
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
	refetchInterval: 5_000,
	staleTime: 3_000,
});

export const getPermissions = queryOptions({
	queryKey: ["permissionsOS"] as const,
	queryFn: () => commands.doPermissionsCheck(true),
	staleTime: 3_000,
});

export function createPermissionsQuery() {
	const [refetchInterval, setRefetchInterval] = createStore<{
		value: number;
	}>({ value: 5_000 });

	const timeoutId = setTimeout(() => {
		setRefetchInterval("value", 15_000);
	}, 30_000);

	onCleanup(() => clearTimeout(timeoutId));

	return createQuery(() => ({
		...getPermissions,
		refetchInterval: refetchInterval.value,
	}));
}

export const isSystemAudioSupported = queryOptions({
	queryKey: ["systemAudioSupported"] as const,
	queryFn: () => commands.isSystemAudioCaptureSupported(),
	staleTime: Number.POSITIVE_INFINITY, // This won't change during runtime
});

type CameraCaptureTarget = ScreenCaptureTarget | { variant: "cameraOnly" };
type ExtendedRecordingTargetMode = RecordingTargetMode | "camera" | null;

export function createOptionsQuery() {
	const PERSIST_KEY = "recording-options-query-2";
	const [_state, _setState] = createStore<{
		captureTarget: CameraCaptureTarget;
		micName: string | null;
		mode: RecordingMode;
		captureSystemAudio?: boolean;
		targetMode?: ExtendedRecordingTargetMode;
		cameraID?: DeviceOrModelID | null;
		organizationId?: string | null;
		/** @deprecated */
		cameraLabel: string | null;
	}>({
		captureTarget: { variant: "display", id: "0" },
		micName: null,
		cameraLabel: null,
		mode: "studio",
		organizationId: null,
	});

	createEventListener(window, "storage", (e) => {
		if (e.key === PERSIST_KEY) _setState(JSON.parse(e.newValue ?? "{}"));
	});

	let initialized = false;

	recordingSettingsStore.get().then((data) => {
		batch(() => {
			if (data?.mode && data.mode !== _state.mode) {
				_setState("mode", data.mode);
			}
			initialized = true;
		});
	});

	createEffect(() => {
		const settings = {
			target: _state.captureTarget,
			micName: _state.micName,
			cameraId: _state.cameraID,
			mode: _state.mode,
			systemAudio: _state.captureSystemAudio,
			organizationId: _state.organizationId,
		};

		if (initialized) {
			recordingSettingsStore.set(settings);
		}
	});

	const storeListenerCleanup = recordingSettingsStore.listen((data) => {
		if (data?.mode && data.mode !== _state.mode) {
			_setState("mode", data.mode);
		}
	});
	onCleanup(() => storeListenerCleanup.then((c) => c()));

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

	const generalSettingsCleanup = generalSettingsStore.listen(() =>
		query.refetch(),
	);
	const authCleanup = authStore.listen(() => query.refetch());

	onCleanup(() => {
		generalSettingsCleanup.then((cleanup) => cleanup());
		authCleanup.then((cleanup) => cleanup());
	});

	return query;
}

export function createCameraMutation() {
	const { setOptions, rawOptions } = useRecordingOptions();

	const rawMutate = async (
		model: DeviceOrModelID | null,
		skipCameraWindow?: boolean,
	) => {
		const before = rawOptions.cameraID ? { ...rawOptions.cameraID } : null;
		setOptions("cameraID", reconcile(model));
		await commands
			.setCameraInput(model, skipCameraWindow ?? null)
			.catch(async (e) => {
				const message =
					typeof e === "string"
						? e
						: e instanceof Error
							? e.message
							: String(e);

				if (message.includes("DeviceNotFound")) {
					setOptions("cameraID", null);
					console.warn("Selected camera is unavailable.");
					return;
				}

				if (JSON.stringify(before) === JSON.stringify(model) || !before) {
					setOptions("cameraID", null);
				} else setOptions("cameraID", reconcile(before));

				throw e;
			});

		if (model && !skipCameraWindow) {
			getCurrentWindow().setFocus();
		}
	};

	const setCameraInput = useMutation(() => ({
		mutationFn: (args: {
			model: DeviceOrModelID | null;
			skipCameraWindow?: boolean;
		}) => rawMutate(args.model, args.skipCameraWindow),
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

export function createOrganizationsQuery() {
	const auth = authStore.createQuery();

	// Refresh organizations if they're missing
	createEffect(() => {
		if (
			auth.data?.user_id &&
			(!auth.data?.organizations || auth.data.organizations.length === 0)
		) {
			commands.updateAuthPlan().catch(console.error);
		}
	});

	return () => auth.data?.organizations ?? [];
}
