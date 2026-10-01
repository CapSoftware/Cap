import { createQuery } from "@tanstack/solid-query";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import { cx } from "cva";
import type { Component, ComponentProps, JSX } from "solid-js";
import { Dynamic } from "solid-js/web";

import {
	createCurrentRecordingQuery,
	isSystemAudioSupported,
} from "~/utils/queries";
import type { AudioCaptureSource } from "~/utils/tauri";
import { useRecordingOptions } from "../OptionsContext";
import {
	DEVICE_ROW_CLASS,
	DEVICE_ROW_ICON_CLASS,
	DEVICE_ROW_LABEL_CLASS,
	DEVICE_ROW_TRAILING_CLASS,
} from "./deviceRowStyles";
import InfoPill from "./InfoPill";

export default function SystemAudio() {
	return (
		<SystemAudioToggleRoot
			class={cx(DEVICE_ROW_CLASS, "KSelect")}
			PillComponent={InfoPill}
			icon={<IconPhMonitorBold class={DEVICE_ROW_ICON_CLASS} />}
		/>
	);
}

export function SystemAudioToggleRoot(
	props: Omit<
		ComponentProps<"button">,
		"onClick" | "disabled" | "title" | "type" | "children"
	> & {
		PillComponent: Component<{
			variant: "blue" | "red" | "gray";
			children: JSX.Element;
		}>;
		icon: JSX.Element;
	},
) {
	const { rawOptions, setOptions } = useRecordingOptions();
	const currentRecording = createCurrentRecordingQuery();
	const systemAudioSupported = createQuery(() => isSystemAudioSupported);

	const isDisabled = () =>
		!!currentRecording.data || systemAudioSupported.data === false;
	const audioSource = () => rawOptions.audioSource ?? "none";
	const applicationAvailable = () =>
		rawOptions.captureTarget.variant === "window";
	const sourceLabel = () => {
		switch (audioSource()) {
			case "system":
				return "System audio";
			case "application":
				return "Selected application";
			default:
				return "No audio";
		}
	};
	const selectSource = (source: AudioCaptureSource) => {
		setOptions({ audioSource: source });
	};
	const openMenu = async () => {
		if (!rawOptions || isDisabled()) return;
		const menu = await Menu.new({
			items: [
				await CheckMenuItem.new({
					text: "None",
					checked: audioSource() === "none",
					action: () => selectSource("none"),
				}),
				await CheckMenuItem.new({
					text: "System audio",
					checked: audioSource() === "system",
					action: () => selectSource("system"),
				}),
				await CheckMenuItem.new({
					text: "Selected application",
					checked: audioSource() === "application",
					enabled: applicationAvailable(),
					action: () => selectSource("application"),
				}),
			],
		});
		await menu.popup();
	};
	const tooltipMessage = () => {
		if (systemAudioSupported.data === false) {
			return "System audio capture requires macOS 13.0 or later";
		}
		return undefined;
	};

	return (
		<button
			{...props}
			type="button"
			title={tooltipMessage()}
			onClick={() => void openMenu()}
			disabled={isDisabled()}
			aria-haspopup="menu"
		>
			{props.icon}
			<p class={DEVICE_ROW_LABEL_CLASS}>{sourceLabel()}</p>
			<div class={DEVICE_ROW_TRAILING_CLASS}>
				<Dynamic
					component={props.PillComponent}
					variant={audioSource() === "none" ? "gray" : "blue"}
				>
					{audioSource() === "none" ? "Off" : "On"}
				</Dynamic>
			</div>
		</button>
	);
}
