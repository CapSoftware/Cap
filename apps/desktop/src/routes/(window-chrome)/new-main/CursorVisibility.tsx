import { createQuery } from "@tanstack/solid-query";
import { cx } from "cva";
import IconPhCursorClickBold from "~icons/ph/cursor-click-bold";
import { createCurrentRecordingQuery } from "~/utils/queries";

import { useRecordingOptions } from "../OptionsContext";
import {
	DEVICE_ROW_CLASS,
	DEVICE_ROW_ICON_CLASS,
	DEVICE_ROW_LABEL_CLASS,
	DEVICE_ROW_TRAILING_CLASS,
} from "./deviceRowStyles";
import InfoPill from "./InfoPill";

export default function CursorVisibility() {
	const { rawOptions, setOptions } = useRecordingOptions();
	const currentRecording = createQuery(createCurrentRecordingQuery);
	const showCursor = () => rawOptions.showCursor !== false;
	const isDisabled = () =>
		!!currentRecording.data || rawOptions.captureTarget.variant === "cameraOnly";

	return (
		<button
			type="button"
			class={cx(DEVICE_ROW_CLASS, "KSelect")}
			onClick={() => setOptions({ showCursor: !showCursor() })}
			aria-pressed={showCursor() ? "true" : "false"}
			disabled={isDisabled()}
		>
			<IconPhCursorClickBold class={DEVICE_ROW_ICON_CLASS} />
			<p class={DEVICE_ROW_LABEL_CLASS}>Show cursor</p>
			<div class={DEVICE_ROW_TRAILING_CLASS}>
				<InfoPill variant={showCursor() ? "blue" : "gray"}>
					{showCursor() ? "On" : "Off"}
				</InfoPill>
			</div>
		</button>
	);
}
