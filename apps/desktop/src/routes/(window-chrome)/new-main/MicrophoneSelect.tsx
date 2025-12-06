import { createQuery } from "@tanstack/solid-query";
import { CheckMenuItem, Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { cx } from "cva";
import {
	type Component,
	type ComponentProps,
	createEffect,
	createSignal,
	Show,
} from "solid-js";
import { trackEvent } from "~/utils/analytics";
import { createTauriEventListener } from "~/utils/createEventListener";
import { createCurrentRecordingQuery, getPermissions } from "~/utils/queries";
import { events } from "~/utils/tauri";
import InfoPill from "./InfoPill";
import TargetSelectInfoPill from "./TargetSelectInfoPill";
import useRequestPermission from "./useRequestPermission";

const NO_MICROPHONE = "No Microphone";

export default function MicrophoneSelect(props: {
	disabled?: boolean;
	options: string[];
	value: string | null;
	onChange: (micName: string | null) => void;
}) {
	return (
		<MicrophoneSelectBase
			{...props}
			class="flex overflow-hidden relative z-10 flex-row gap-2 items-center px-2 w-full h-9 rounded-lg transition-colors cursor-default disabled:opacity-70 bg-gray-3 disabled:text-gray-11 KSelect"
			levelIndicatorClass="bg-blue-7"
			iconClass="text-gray-10 size-4"
			PillComponent={InfoPill}
		/>
	);
}

export function MicrophoneSelectBase(props: {
	disabled?: boolean;
	options: string[];
	value: string | null;
	onChange: (micName: string | null) => void;
	class: string;
	levelIndicatorClass: string;
	iconClass: string;
	PillComponent: Component<
		ComponentProps<"button"> & { variant: "blue" | "red" }
	>;
}) {
	const DB_SCALE = 40;

	const permissions = createQuery(() => getPermissions);
	const currentRecording = createCurrentRecordingQuery();

	const [dbs, setDbs] = createSignal<number | undefined>();
	const [isInitialized, setIsInitialized] = createSignal(false);

	const requestPermission = useRequestPermission();

	const permissionGranted = () =>
		permissions?.data?.microphone === "granted" ||
		permissions?.data?.microphone === "notNeeded";

	type Option = { name: string };

	const handleMicrophoneChange = async (item: Option | null) => {
		if (!props.options) return;
		props.onChange(item ? item.name : null);
		if (!item) setDbs();

		trackEvent("microphone_selected", {
			microphone_name: item?.name ?? null,
			enabled: !!item,
		});
	};

	createTauriEventListener(events.audioInputLevelChange, (dbs) => {
		if (!props.value) setDbs();
		else setDbs(dbs);
	});

	// visual audio level from 0 -> 1
	const audioLevel = () =>
		(1 - Math.max((dbs() ?? 0) + DB_SCALE, 0) / DB_SCALE) ** 0.5;

	createEffect(() => {
		if (!props.value || !permissionGranted() || isInitialized()) return;

		setIsInitialized(true);
		void handleMicrophoneChange({ name: props.value });
	});

	return (
		<div class="flex flex-col gap-1 items-stretch text-(--text-primary)">
			<button
				type="button"
				disabled={!!currentRecording.data || props.disabled}
				class={props.class}
				onClick={() => {
					if (!permissionGranted()) {
						requestPermission("microphone");
						return;
					}

					Promise.all([
						CheckMenuItem.new({
							text: NO_MICROPHONE,
							checked: props.value === null,
							action: () => handleMicrophoneChange(null),
						}),
						PredefinedMenuItem.new({ item: "Separator" }),
						...(props.options ?? []).map((name) =>
							CheckMenuItem.new({
								text: name,
								checked: name === props.value,
								action: () => handleMicrophoneChange({ name: name }),
							}),
						),
					])
						.then((items) => Menu.new({ items }))
						.then((m) => {
							m.popup();
						});
				}}
			>
				<Show when={props.value !== null && dbs()}>
					{(_) => (
						<div
							class={cx(
								"opacity-50 left-0 inset-y-0 absolute transition-[right] duration-100 -z-10",
								props.levelIndicatorClass,
							)}
							style={{ right: `${audioLevel() * 100}%` }}
						/>
					)}
				</Show>
				<IconCapMicrophone class={props.iconClass} />
				<p class="flex-1 text-sm text-left truncate">
					{props.value ?? NO_MICROPHONE}
				</p>
				<TargetSelectInfoPill
					PillComponent={props.PillComponent}
					value={props.value}
					permissionGranted={permissionGranted()}
					requestPermission={() => requestPermission("microphone")}
					onClick={(e) => {
						if (props.value !== null) {
							e.stopPropagation();
							props.onChange(null);
						}
					}}
				/>
			</button>
		</div>
	);
}
