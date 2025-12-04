import { createQuery } from "@tanstack/solid-query";
import { CheckMenuItem, Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import type { Component, ComponentProps } from "solid-js";
import { trackEvent } from "~/utils/analytics";
import { createCurrentRecordingQuery, getPermissions } from "~/utils/queries";
import type { CameraInfo } from "~/utils/tauri";
import InfoPill from "./InfoPill";
import TargetSelectInfoPill from "./TargetSelectInfoPill";
import useRequestPermission from "./useRequestPermission";
import { CameraIcon, ChevronDown } from "~/icons";

const NO_CAMERA = "No Camera";

export default function CameraSelect(props: {
	disabled?: boolean;
	options: CameraInfo[];
	value: CameraInfo | null;
	onChange: (camera: CameraInfo | null) => void;
}) {
	return (
		<CameraSelectBase
			{...props}
			PillComponent={InfoPill}
			class="flex flex-row gap-2 items-center px-2 w-full h-9 rounded-lg transition-colors cursor-default disabled:opacity-70 cursor-pointer hover:bg-white/[0.03] disabled:text-gray-11 text-white/80 hover:text-white KSelect group"
			iconClass="size-4"
		/>
	);
}

export function CameraSelectBase(props: {
	disabled?: boolean;
	options: CameraInfo[];
	value: CameraInfo | null;
	onChange: (camera: CameraInfo | null) => void;
	PillComponent: Component<ComponentProps<"button"> & { variant: "blue" | "red" }>;
	class: string;
	iconClass: string;
}) {
	const currentRecording = createCurrentRecordingQuery();
	const permissions = createQuery(() => getPermissions);
	const requestPermission = useRequestPermission();

	const permissionGranted = () => permissions?.data?.camera === "granted" || permissions?.data?.camera === "notNeeded";

	const onChange = (cameraLabel: CameraInfo | null) => {
		if (!cameraLabel && !permissionGranted()) return requestPermission("camera");

		props.onChange(cameraLabel);

		trackEvent("camera_selected", {
			camera_name: cameraLabel?.display_name ?? null,
			enabled: !!cameraLabel,
		});
	};

	return (
		<div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
			<button
				type="button"
				disabled={!!currentRecording.data || props.disabled}
				onClick={() => {
					if (!permissionGranted()) {
						requestPermission("camera");
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
							})
						),
					])
						.then((items) => Menu.new({ items }))
						.then((m) => {
							m.popup();
						});
				}}
				class={props.class}
			>
				<CameraIcon class={props.iconClass} />
				<p class="flex-1 text-xs text-left truncate">{props.value?.display_name ?? NO_CAMERA}</p>

				<div class="opacity-0 group-hover:opacity-100 transition-opacity duration-200">
					<ChevronDown class={props.iconClass} />
				</div>
				{/* <TargetSelectInfoPill
					PillComponent={props.PillComponent}
					value={props.value}
					permissionGranted={permissionGranted()}
					requestPermission={() => requestPermission("camera")}
					onClick={(e) => {
						if (!props.options) return;
						if (props.value !== null) {
							e.stopPropagation();
							props.onChange(null);
						}
					}}
				/> */}
			</button>
		</div>
	);
}
