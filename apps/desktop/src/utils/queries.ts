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
type RecordingTargetModeSource = "main" | "editor" | "editorRecording" | null;
/**
 * Why the target picker was last dismissed. Written in the same `setOptions`
 * call that sets `targetMode: null`, so it reaches other webviews atomically
 * with the dismissal. The main window's reveal logic keys off this instead of
 * reconstructing the outcome from query data or effect ordering — the hidden
 * main webview can be suspended by WebKit, which makes any state it derives
 * "at dismissal time" arbitrarily stale.
 */
export type TargetModeDismissal =
	| "recordingStudio"
	| "recordingInstant"
	| "screenshot"
	| "superseded"
	| "cancelled";

function isStoredCameraId(value: unknown): value is DeviceOrModelID | null {
	if (value === null) return true;
	if (typeof value !== "object" || Object.keys(value).length !== 1)
		return false;
	if ("DeviceID" in value) {
		return typeof value.DeviceID === "string" && value.DeviceID.length > 0;
	}
	if ("ModelID" in value) {
		return typeof value.ModelID === "string" && value.ModelID.includes(":");
	}
	return false;
}

export function createOptionsQuery() {
	const PERSIST_KEY = "recording-options-query-2";
	const [_state, _setState] = createStore<{
		captureTarget: CameraCaptureTarget;
		micName: string | null;
		mode: RecordingMode;
		captureSystemAudio?: boolean;
		targetMode?: ExtendedRecordingTargetMode;
		targetModeSource?: RecordingTargetModeSource;
		targetModeDismissal?: TargetModeDismissal | null;
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

	let microphoneRevision = 0;
	let cameraRevision = 0;
	const markInputChanges = (update: unknown) => {
		if (
			update === "micName" ||
			(typeof update === "object" && update !== null && "micName" in update)
		)
			microphoneRevision++;
		if (
			update === "cameraID" ||
			(typeof update === "object" && update !== null && "cameraID" in update)
		)
			cameraRevision++;
	};
	createEventListener(window, "storage", (e) => {
		if (e.key === PERSIST_KEY) {
			const update: unknown = JSON.parse(e.newValue ?? "{}");
			if (typeof update === "object" && update !== null) {
				const options =
					"cameraID" in update
						? {
								...update,
								cameraID: isStoredCameraId(update.cameraID)
									? update.cameraID
									: null,
							}
						: update;
				markInputChanges(options);
				_setState(options);
			}
		}
	});

	let initialized = false;

	recordingSettingsStore.get().then((data) => {
		batch(() => {
			if (data?.target) {
				_setState("captureTarget", data.target);
			}
			if (data?.micName !== undefined && microphoneRevision === 0) {
				_setState("micName", data.micName);
			}
			if (
				data?.cameraId !== undefined &&
				cameraRevision === 0 &&
				isStoredCameraId(data.cameraId)
			) {
				_setState("cameraID", reconcile(data.cameraId));
			}
			if (data?.mode && data.mode !== _state.mode) {
				_setState("mode", data.mode);
			}
			if (data?.systemAudio !== undefined) {
				_setState("captureSystemAudio", data.systemAudio);
			}
			if (data?.organizationId !== undefined) {
				_setState("organizationId", data.organizationId);
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
	if (state.cameraID !== undefined && !isStoredCameraId(state.cameraID)) {
		setState("cameraID", null);
	}

	const setOptions = new Proxy(setState, {
		apply(target, thisArg, args) {
			markInputChanges(args[0]);
			return Reflect.apply(target, thisArg, args);
		},
	});
	return { rawOptions: state, setOptions };
}

export function createCleanCaptureQuery() {
	const query = createQuery(() => ({
		queryKey: ["cleanCapture"] as const,
		queryFn: () => commands.getCleanCaptureState(),
		refetchOnWindowFocus: true,
	}));
	createQueryInvalidate(query, "currentRecordingChanged");
	return query;
}

export async function revealRecordingWindow(generation?: number) {
	const currentGeneration =
		generation ?? (await commands.getCleanCaptureState()).generation;
	return commands.revealCaptureWindow(currentGeneration, null);
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

function inputRequestWasSuperseded(error: unknown) {
	return String(error).includes("selection was superseded by a newer request");
}

export function createMicrophoneMutation() {
	const { setOptions, rawOptions } = useRecordingOptions();
	return useMutation(() => ({
		mutationFn: async (name: string | null) => {
			setOptions("micName", name);
			try {
				await commands.setMicInput(name);
			} catch (error) {
				if (
					(rawOptions.micName ?? null) !== name ||
					inputRequestWasSuperseded(error)
				)
					return;
				throw error;
			}
		},
	}));
}

export function createCameraMutation() {
	const { setOptions, rawOptions } = useRecordingOptions();

	const rawMutate = async (
		model: DeviceOrModelID | null,
		skipCameraWindow?: boolean,
	) => {
		setOptions("cameraID", reconcile(model));
		try {
			await commands.setCameraInput(model, skipCameraWindow ?? null);
		} catch (error) {
			if (
				JSON.stringify(rawOptions.cameraID ?? null) !== JSON.stringify(model) ||
				inputRequestWasSuperseded(error)
			)
				return;
			throw error;
		}

		if (
			model &&
			!skipCameraWindow &&
			JSON.stringify(rawOptions.cameraID) === JSON.stringify(model)
		) {
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
		// This is read during the editor's initial render, under its top-level
		// Suspense boundary. Without placeholder data, a slow/offline network
		// keeps the query pending and the whole editor stuck on the skeleton.
		placeholderData: { custom_domain: null, domain_verified: null },
		refetchOnMount: true,
		refetchOnWindowFocus: true,
	}));
}

export function createOrganizationsQuery() {
	const auth = authStore.createQuery();

	// Bootstrap only: auth.rs stamps organizations_updated_at even on org-fetch failure, stopping the loop on self-hosted where the endpoint is absent.
	createEffect(() => {
		if (auth.data?.user_id && !auth.data?.organizations_updated_at) {
			commands.updateAuthPlan().catch(console.error);
		}
	});

	return () => auth.data?.organizations ?? [];
}
