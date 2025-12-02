import { createQuery } from "@tanstack/solid-query";
import type { Component, ComponentProps, JSX } from "solid-js";
import { Dynamic } from "solid-js/web";

import {
	createCurrentRecordingQuery,
	isSystemAudioSupported,
} from "~/utils/queries";
import { useRecordingOptions } from "../OptionsContext";
import InfoPill, { InfoPillNew } from "./InfoPill";
import { SystemAudioIcon } from "~/icons";

export default function SystemAudio() {
	return (
		<SystemAudioToggleRoot
			class="flex flex-row gap-2 items-center px-2 w-full h-9 rounded-lg transition-colors cursor-default disabled:opacity-70 cursor-pointer hover:bg-white/[0.03] disabled:text-gray-11 text-neutral-300 hover:text-white KSelect"
			PillComponent={InfoPillNew}
			icon={<SystemAudioIcon class="size-4" />}
		/>
	);
}

export function SystemAudioToggleRoot(
	props: Omit<
		ComponentProps<"button">,
		"onClick" | "disabled" | "title" | "type" | "children"
	> & {
		PillComponent: Component<{
			variant: "on" | "off";
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
			onClick={() => {
				if (!rawOptions || isDisabled()) return;
				setOptions({ captureSystemAudio: !rawOptions.captureSystemAudio });
			}}
			disabled={isDisabled()}
		>
			{props.icon}
			<p class="flex-1 text-sm text-left truncate">
				{rawOptions.captureSystemAudio
					? "Record System Audio"
					: "No System Audio"}
			</p>
			<Dynamic
				component={props.PillComponent}
				variant={rawOptions.captureSystemAudio ? "on" : "off"}
			>
				{rawOptions.captureSystemAudio ? "On" : "Off"}
			</Dynamic>
		</button>
	);
}
