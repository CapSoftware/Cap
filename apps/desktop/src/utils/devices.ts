import { queryOptions, useQuery } from "@tanstack/solid-query";
import {
	type Accessor,
	createEffect,
	createMemo,
	onCleanup,
	untrack,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
	type CameraFormatInfo,
	type CameraInfo,
	commands,
	events,
	type OSPermissionsCheck,
} from "./tauri";

export type DevicesSnapshot = {
	cameras: CameraInfo[];
	microphones: string[];
	permissions: OSPermissionsCheck;
};

export type CameraWithDetails = CameraInfo & {
	bestFormat?: { width: number; height: number; frameRate: number };
	formats?: CameraFormatInfo[];
};

export type MicrophoneFormatInfo = {
	sampleRate: number;
	channels: number;
};

export type MicrophoneWithDetails = {
	name: string;
	sampleRate?: number;
	channels?: number;
	formats?: MicrophoneFormatInfo[];
};

export const devicesSnapshot = queryOptions({
	queryKey: ["devicesSnapshot"] as const,
	queryFn: () => commands.getDevicesSnapshot(),
	staleTime: 3_000,
	refetchInterval: 5_000,
});

export function createDevicesQuery(enabled: Accessor<boolean> = () => true) {
	const query = useQuery(() => ({
		...devicesSnapshot,
		enabled: enabled(),
		refetchInterval: enabled() ? devicesSnapshot.refetchInterval : false,
	}));

	createEffect(() => {
		const unlisten = events.devicesUpdated.listen(() => {
			if (!enabled()) return;
			query.refetch();
		});

		onCleanup(() => {
			unlisten.then((fn) => fn());
		});
	});

	return query;
}

type CameraDetailsCache = Record<
	string,
	{ bestFormat?: CameraFormatInfo; formats?: CameraFormatInfo[] }
>;
type MicDetailsCache = Record<
	string,
	{ sampleRate: number; channels: number; formats?: MicrophoneFormatInfo[] }
>;

function cameraListChanged(
	oldList: CameraWithDetails[],
	newList: CameraInfo[],
): boolean {
	if (oldList.length !== newList.length) return true;
	const oldIds = new Set(oldList.map((c) => c.device_id));
	return newList.some((c) => !oldIds.has(c.device_id));
}

function micListChanged(
	oldList: MicrophoneWithDetails[],
	newList: string[],
): boolean {
	if (oldList.length !== newList.length) return true;
	const oldNames = new Set(oldList.map((m) => m.name));
	return newList.some((name) => !oldNames.has(name));
}

export function createStableDevicesQuery(
	enabled: Accessor<boolean> = () => true,
) {
	const query = createDevicesQuery(enabled);

	const [cameras, setCameras] = createStore<CameraWithDetails[]>([]);
	const [microphones, setMicrophones] = createStore<MicrophoneWithDetails[]>(
		[],
	);

	const cameraDetailsCache: CameraDetailsCache = {};
	const micDetailsCache: MicDetailsCache = {};
	const pendingCameraFetches = new Set<string>();
	const pendingMicFetches = new Set<string>();

	createEffect(() => {
		const rawCameras = query.data?.cameras ?? [];

		const currentCameras = untrack(() => cameras);
		const hasListChanged = cameraListChanged(currentCameras, rawCameras);

		if (hasListChanged) {
			const existingMap = new Map(
				currentCameras.map((c) => [
					c.device_id,
					{ bestFormat: c.bestFormat, formats: c.formats },
				]),
			);

			const newCameras: CameraWithDetails[] = rawCameras.map((c) => ({
				...c,
				...(cameraDetailsCache[c.device_id] ?? existingMap.get(c.device_id)),
			}));

			setCameras(newCameras);
		}

		for (const camera of rawCameras) {
			if (
				!cameraDetailsCache[camera.device_id] &&
				!pendingCameraFetches.has(camera.device_id)
			) {
				pendingCameraFetches.add(camera.device_id);
				commands.getCameraFormats(camera.device_id).then((formats) => {
					pendingCameraFetches.delete(camera.device_id);
					if (formats) {
						const details = {
							bestFormat: formats.bestFormat ?? undefined,
							formats: formats.formats,
						};
						cameraDetailsCache[camera.device_id] = details;
						setCameras(
							produce((cams) => {
								const cam = cams.find((c) => c.device_id === camera.device_id);
								if (cam) {
									cam.bestFormat = details.bestFormat;
									cam.formats = details.formats;
								}
							}),
						);
					}
				});
			}
		}
	});

	createEffect(() => {
		const rawMics = query.data?.microphones ?? [];

		const currentMics = untrack(() => microphones);
		const hasListChanged = micListChanged(currentMics, rawMics);

		if (hasListChanged) {
			const existingMap = new Map(
				currentMics.map((m) => [
					m.name,
					{
						sampleRate: m.sampleRate,
						channels: m.channels,
						formats: m.formats,
					},
				]),
			);

			const newMics: MicrophoneWithDetails[] = rawMics.map((name) => ({
				name,
				...(micDetailsCache[name] ?? existingMap.get(name)),
			}));

			setMicrophones(newMics);
		}

		for (const name of rawMics) {
			if (!micDetailsCache[name] && !pendingMicFetches.has(name)) {
				pendingMicFetches.add(name);
				commands.getMicrophoneInfo(name).then((info) => {
					pendingMicFetches.delete(name);
					if (info) {
						const extendedInfo = info as typeof info & {
							formats?: MicrophoneFormatInfo[];
						};
						const details = {
							sampleRate: info.sampleRate,
							channels: info.channels,
							formats: extendedInfo.formats,
						};
						micDetailsCache[name] = details;
						setMicrophones(
							produce((mics) => {
								const mic = mics.find((m) => m.name === name);
								if (mic) {
									mic.sampleRate = details.sampleRate;
									mic.channels = details.channels;
									mic.formats = details.formats;
								}
							}),
						);
					}
				});
			}
		}
	});

	const permissions = createMemo(() => query.data?.permissions);

	return {
		get cameras() {
			return cameras;
		},
		get microphones() {
			return microphones;
		},
		get permissions() {
			return permissions();
		},
		get isPending() {
			return query.isPending;
		},
		get isLoading() {
			return query.isLoading;
		},
		get isFetching() {
			return query.isFetching;
		},
	};
}
