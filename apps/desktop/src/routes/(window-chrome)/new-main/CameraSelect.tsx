import { createTimer } from "@solid-primitives/timer";
import { CheckMenuItem, Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import {
	type Component,
	type ComponentProps,
	createEffect,
	createSignal,
	Show,
} from "solid-js";
import { trackEvent } from "~/utils/analytics";
import { createCurrentRecordingQuery } from "~/utils/queries";
import {
	type CameraInfo,
	commands,
	type DeviceOrModelID,
	type OSPermissionsCheck,
} from "~/utils/tauri";
import InfoPill from "./InfoPill";
import TargetSelectInfoPill from "./TargetSelectInfoPill";
import useRequestPermission from "./useRequestPermission";

const NO_CAMERA = "No Camera";

export default function CameraSelect(props: {
	disabled?: boolean;
	options: CameraInfo[];
	value: CameraInfo | null;
	onChange: (camera: CameraInfo | null) => void;
	permissions?: OSPermissionsCheck;
	hidePreviewButton?: boolean;
	onOpen?: () => void;
}) {
	const currentRecording = createCurrentRecordingQuery();
	const requestPermission = useRequestPermission();
	const [cameraWindowOpen, setCameraWindowOpen] = createSignal(false);

	const refreshCameraWindowState = async () => {
		try {
			setCameraWindowOpen(await commands.isCameraWindowOpen());
		} catch {
			setCameraWindowOpen(false);
		}
	};

	createEffect(() => {
		if (props.value) {
			void refreshCameraWindowState();
		} else {
			setCameraWindowOpen(false);
		}
	});

	createTimer(
		() => {
			if (props.value) {
				void refreshCameraWindowState();
			}
		},
		2000,
		setInterval,
	);

	const openCameraWindow = async (e: MouseEvent) => {
		e.stopPropagation();
		if (props.value) {
			const id: DeviceOrModelID = props.value.model_id
				? { ModelID: props.value.model_id }
				: { DeviceID: props.value.device_id };
			await commands.setCameraInput(id, false);
		} else {
			await commands.showWindow({ Camera: { centered: false } });
		}
		await refreshCameraWindowState();
	};

	const permissionGranted = () =>
		props.permissions?.camera === "granted" ||
		props.permissions?.camera === "notNeeded";

	const showHiddenIndicator = () =>
		props.value !== null &&
		permissionGranted() &&
		!cameraWindowOpen() &&
		!props.hidePreviewButton;

	return (
		<div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
			<button
				type="button"
				disabled={!!currentRecording.data || props.disabled}
				onClick={() => {
					if (!permissionGranted()) {
						requestPermission("camera", props.permissions?.camera);
						return;
					}
					props.onOpen?.();
				}}
				class="flex flex-row gap-2 items-center px-2 w-full h-[42px] rounded-lg border border-gray-5 transition-colors cursor-default disabled:opacity-70 bg-gray-3 disabled:text-gray-11 KSelect"
			>
				<IconCapCamera class="text-gray-10 size-4" />
				<p class="flex-1 text-sm text-left truncate">
					{props.value?.display_name ?? NO_CAMERA}
				</p>
				<div class="flex items-center gap-1">
					<Show when={showHiddenIndicator()}>
						<button
							type="button"
							onClick={openCameraWindow}
							onPointerDown={(e) => e.stopPropagation()}
							class="flex items-center justify-center px-2 py-1 rounded-full bg-gray-6 text-gray-11 hover:bg-gray-7 transition-colors"
							title="Show camera preview"
						>
							<IconLucideEyeOff class="size-3.5" />
						</button>
					</Show>
					<TargetSelectInfoPill
						PillComponent={InfoPill}
						value={props.value}
						permissionGranted={permissionGranted()}
						requestPermission={() =>
							requestPermission("camera", props.permissions?.camera)
						}
						onClick={(e) => {
							if (!props.options) return;
							if (props.value !== null) {
								e.stopPropagation();
								props.onChange(null);
							}
						}}
					/>
				</div>
			</button>
		</div>
	);
}

export function CameraSelectBase(props: {
	disabled?: boolean;
	options: CameraInfo[];
	value: CameraInfo | null;
	onChange: (camera: CameraInfo | null) => void;
	PillComponent: Component<
		ComponentProps<"button"> & { variant: "blue" | "red" }
	>;
	class: string;
	iconClass: string;
	permissions?: OSPermissionsCheck;
	hidePreviewButton?: boolean;
}) {
	const currentRecording = createCurrentRecordingQuery();
	const requestPermission = useRequestPermission();
	const [cameraWindowOpen, setCameraWindowOpen] = createSignal(false);

	const refreshCameraWindowState = async () => {
		try {
			setCameraWindowOpen(await commands.isCameraWindowOpen());
		} catch {
			setCameraWindowOpen(false);
		}
	};

	createEffect(() => {
		if (props.value) {
			void refreshCameraWindowState();
		} else {
			setCameraWindowOpen(false);
		}
	});

	createTimer(
		() => {
			if (props.value) {
				void refreshCameraWindowState();
			}
		},
		2000,
		setInterval,
	);

	const openCameraWindow = async (e: MouseEvent) => {
		e.stopPropagation();
		if (props.value) {
			const id: DeviceOrModelID = props.value.model_id
				? { ModelID: props.value.model_id }
				: { DeviceID: props.value.device_id };
			await commands.setCameraInput(id, false);
		} else {
			await commands.showWindow({ Camera: { centered: false } });
		}
		await refreshCameraWindowState();
	};

	const permissionGranted = () =>
		props.permissions?.camera === "granted" ||
		props.permissions?.camera === "notNeeded";

	const onChange = (cameraLabel: CameraInfo | null) => {
		if (!cameraLabel && !permissionGranted())
			return requestPermission("camera", props.permissions?.camera);

		props.onChange(cameraLabel);

		trackEvent("camera_selected", {
			camera_name: cameraLabel?.display_name ?? null,
			enabled: !!cameraLabel,
		});
	};

	const showHiddenIndicator = () =>
		props.value !== null &&
		permissionGranted() &&
		!cameraWindowOpen() &&
		!props.hidePreviewButton;

	return (
		<div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
			<button
				type="button"
				disabled={!!currentRecording.data || props.disabled}
				onClick={() => {
					if (!permissionGranted()) {
						requestPermission("camera", props.permissions?.camera);
						return;
					}

					Promise.all([
						CheckMenuItem.new({
							text: NO_CAMERA,
							checked: props.value === null,
							action: () => onChange(null),
						}),
						PredefinedMenuItem.new({ item: "Separator" }),
						...props.options.map((o) =>
							CheckMenuItem.new({
								text: o.display_name,
								checked: o === props.value,
								action: () => onChange(o),
							}),
						),
					])
						.then((items) => Menu.new({ items }))
						.then((m) => {
							m.popup();
						});
				}}
				class={props.class}
			>
				<IconCapCamera class={props.iconClass} />
				<p class="flex-1 text-sm text-left truncate">
					{props.value?.display_name ?? NO_CAMERA}
				</p>
				<div class="flex items-center gap-1">
					{showHiddenIndicator() && (
						<button
							type="button"
							onClick={openCameraWindow}
							onPointerDown={(e) => e.stopPropagation()}
							class="flex items-center justify-center px-2 py-1 rounded-full bg-gray-6 text-gray-11 hover:bg-gray-7 transition-colors"
							title="Show camera preview"
						>
							<IconLucideEyeOff class="size-3.5" />
						</button>
					)}
					<TargetSelectInfoPill
						PillComponent={props.PillComponent}
						value={props.value}
						permissionGranted={permissionGranted()}
						requestPermission={() =>
							requestPermission("camera", props.permissions?.camera)
						}
						onClick={(e) => {
							if (!props.options) return;
							if (props.value !== null) {
								e.stopPropagation();
								props.onChange(null);
							}
						}}
					/>
				</div>
			</button>
		</div>
	);
}
