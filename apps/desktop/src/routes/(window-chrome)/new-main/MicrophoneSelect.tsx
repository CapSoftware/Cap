import { CheckMenuItem, Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { cx } from "cva";
import {
	type Component,
	type ComponentProps,
	createSignal,
	Show,
} from "solid-js";
import { trackEvent } from "~/utils/analytics";
import { createTauriEventListener } from "~/utils/createEventListener";
import { createCurrentRecordingQuery } from "~/utils/queries";
import { events, type OSPermissionsCheck } from "~/utils/tauri";
import {
	DEVICE_ROW_CLASS,
	DEVICE_ROW_ICON_CLASS,
	DEVICE_ROW_LABEL_CLASS,
	DEVICE_ROW_TRAILING_CLASS,
	DEVICE_SHORTCUT_BUTTON_CLASS,
} from "./deviceRowStyles";
import InfoPill from "./InfoPill";
import TargetSelectInfoPill from "./TargetSelectInfoPill";
import useRequestPermission from "./useRequestPermission";

const NO_MICROPHONE = "No Microphone";

export default function MicrophoneSelect(props: {
	disabled?: boolean;
	options: string[];
	value: string | null;
	onChange: (micName: string | null) => void;
	permissions?: OSPermissionsCheck;
	onOpen?: () => void;
	onOpenSettings?: () => void;
}) {
	const DB_SCALE = 40;
	const currentRecording = createCurrentRecordingQuery();
	const requestPermission = useRequestPermission();

	const [dbs, setDbs] = createSignal<number | undefined>();

	const permissionGranted = () =>
		props.permissions === undefined ||
		props.permissions.microphone === "granted" ||
		props.permissions.microphone === "notNeeded";

	const handleMicrophoneChange = async (name: string | null) => {
		if (!props.options) return;
		props.onChange(name);
		if (!name) setDbs();

		trackEvent("microphone_selected", {
			microphone_name: name ?? null,
			enabled: !!name,
		});
	};

	createTauriEventListener(events.audioInputLevelChange, (d) => {
		if (!props.value) setDbs();
		else setDbs(d);
	});

	const audioLevel = () =>
		(1 - Math.max((dbs() ?? 0) + DB_SCALE, 0) / DB_SCALE) ** 0.5;

	const showLevel = () => props.value !== null && dbs() !== undefined;

	const showSettingsShortcut = () =>
		props.value !== null && permissionGranted() && !!props.onOpenSettings;

	const isDisabled = () => !!currentRecording.data || props.disabled;

	return (
		<div class="flex flex-col items-stretch text-[--text-primary]">
			<button
				type="button"
				disabled={isDisabled()}
				class={cx(DEVICE_ROW_CLASS, "KSelect")}
				onClick={() => {
					if (!permissionGranted()) {
						requestPermission("microphone", props.permissions?.microphone);
						return;
					}
					props.onOpen?.();
				}}
				aria-haspopup="menu"
			>
				<Show when={showLevel()}>
					<div
						class="absolute inset-y-0 left-0 -z-10 transition-[right] duration-100 pointer-events-none bg-blue-9/10"
						style={{ right: `${audioLevel() * 100}%` }}
					/>
					<div
						class="absolute bottom-0 left-0 h-[2px] -z-10 transition-[right] duration-100 pointer-events-none bg-blue-9"
						style={{ right: `${audioLevel() * 100}%` }}
					/>
				</Show>
				<IconCapMicrophone class={DEVICE_ROW_ICON_CLASS} />
				<p class={DEVICE_ROW_LABEL_CLASS}>{props.value ?? NO_MICROPHONE}</p>
				<div class={DEVICE_ROW_TRAILING_CLASS}>
					<Show when={showSettingsShortcut()}>
						<button
							type="button"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								props.onOpenSettings?.();
							}}
							onPointerDown={(e) => e.stopPropagation()}
							class={DEVICE_SHORTCUT_BUTTON_CLASS}
							title="Microphone settings"
							aria-label="Microphone settings"
						>
							<IconLucideSettings class="size-3.5" />
						</button>
					</Show>
					<TargetSelectInfoPill
						PillComponent={InfoPill}
						value={props.value}
						permissionGranted={permissionGranted()}
						requestPermission={() =>
							requestPermission("microphone", props.permissions?.microphone)
						}
						onClick={(e) => {
							if (props.value !== null) {
								e.stopPropagation();
								void handleMicrophoneChange(null);
							}
						}}
					/>
				</div>
			</button>
		</div>
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
		ComponentProps<"button"> & { variant: "blue" | "red" | "gray" }
	>;
	permissions?: OSPermissionsCheck;
}) {
	const DB_SCALE = 40;

	const currentRecording = createCurrentRecordingQuery();

	const [dbs, setDbs] = createSignal<number | undefined>();

	const requestPermission = useRequestPermission();

	const permissionGranted = () =>
		props.permissions === undefined ||
		props.permissions.microphone === "granted" ||
		props.permissions.microphone === "notNeeded";

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

	const audioLevel = () =>
		(1 - Math.max((dbs() ?? 0) + DB_SCALE, 0) / DB_SCALE) ** 0.5;

	return (
		<div class="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
			<button
				type="button"
				disabled={!!currentRecording.data || props.disabled}
				class={props.class}
				onClick={() => {
					if (!permissionGranted()) {
						requestPermission("microphone", props.permissions?.microphone);
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
					requestPermission={() =>
						requestPermission("microphone", props.permissions?.microphone)
					}
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
