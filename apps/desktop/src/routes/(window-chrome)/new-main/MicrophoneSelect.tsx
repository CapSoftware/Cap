import { createQuery } from "@tanstack/solid-query";
import { CheckMenuItem, Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { cx } from "cva";
import { type Component, type ComponentProps, createSignal, onMount, Show } from "solid-js";
import { trackEvent } from "~/utils/analytics";
import { createTauriEventListener } from "~/utils/createEventListener";
import { createCurrentRecordingQuery, getPermissions } from "~/utils/queries";
import { events } from "~/utils/tauri";
import InfoPill from "./InfoPill";
import TargetSelectInfoPill from "./TargetSelectInfoPill";
import useRequestPermission from "./useRequestPermission";
import { ChevronDown, MicrophoneIcon } from "~/icons";

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
			class="flex flex-row gap-2 items-center px-2 w-full h-9 rounded-lg transition-colors cursor-default disabled:opacity-70 cursor-pointer hover:bg-white/[0.03] disabled:text-gray-11 text-neutral-300 hover:text-white KSelect group"
			levelIndicatorClass="bg-blue-7"
			iconClass="size-4"
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
	PillComponent: Component<ComponentProps<"button"> & { variant: "blue" | "red" }>;
}) {
	const DB_SCALE = 40;

	const permissions = createQuery(() => getPermissions);
	const currentRecording = createCurrentRecordingQuery();

	const [dbs, setDbs] = createSignal<number | undefined>();
	const [isInitialized, setIsInitialized] = createSignal(false);

	const requestPermission = useRequestPermission();

	const permissionGranted = () =>
		permissions?.data?.microphone === "granted" || permissions?.data?.microphone === "notNeeded";

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
	const audioLevel = () => (1 - Math.max((dbs() ?? 0) + DB_SCALE, 0) / DB_SCALE) ** 0.5;

	// Initialize audio input if needed - only once when component mounts
	onMount(() => {
		if (!props.value || !permissionGranted() || isInitialized()) return;

		setIsInitialized(true);
		// Ensure the selected microphone is activated so levels flow in
		void handleMicrophoneChange({ name: props.value });
	});

	return (
		<div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
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
							})
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
								props.levelIndicatorClass
							)}
							style={{ right: `${audioLevel() * 100}%` }}
						/>
					)}
				</Show>
				<MicrophoneIcon class={props.iconClass} />
				<p class="flex-1 text-sm text-left truncate">{props.value ?? NO_MICROPHONE}</p>

				<div class="opacity-0 group-hover:opacity-100 transition-opacity duration-200">
					<ChevronDown class={props.iconClass} />
				</div>
				{/* <TargetSelectInfoPill
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
				/> */}
			</button>
		</div>
	);
}
