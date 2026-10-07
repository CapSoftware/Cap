import { createMemo, Show } from "solid-js";
import {
	defaultKeyboardSettings,
	type KeycapStyle,
	type KeycapTheme,
} from "~/store/keyboard";
import { useEditorContext } from "./context";
import { KeycapPreviewCluster, parseShortcutKeys } from "./keycap-renderer";

type KeyboardOverlayProps = {
	size: { width: number; height: number };
};

export function KeyboardOverlay(props: KeyboardOverlayProps) {
	const { project, editorState } = useEditorContext();

	const currentAbsoluteTime = () =>
		editorState.previewTime ?? editorState.playbackTime ?? 0;

	const settings = createMemo(() => ({
		...defaultKeyboardSettings,
		...project.keyboard?.settings,
	}));

	const isTrackEnabled = () => editorState.timeline.tracks.keyboard ?? true;

	const activeSegment = createMemo(() => {
		if (!settings().enabled || !isTrackEnabled()) return null;
		const time = currentAbsoluteTime();
		const segments = project.timeline?.keyboardSegments ?? [];
		return segments.find((seg) => time >= seg.start && time <= seg.end) ?? null;
	});

	const parsedKeys = createMemo(() => {
		const seg = activeSegment();
		if (!seg) return [];
		return parseShortcutKeys(seg.displayText || "");
	});

	const positionClasses = createMemo(() => {
		const pos = settings().position || "bottom-center";
		switch (pos) {
			case "top-left":
				return "items-start justify-start pt-14 pl-12";
			case "top-center":
			case "top":
				return "items-start justify-center pt-14";
			case "top-right":
				return "items-start justify-end pt-14 pr-12";
			case "bottom-left":
				return "items-end justify-start pb-32 pl-12";
			case "bottom-right":
				return "items-end justify-end pb-32 pr-12";
			default:
				return "items-end justify-center pb-32";
		}
	});

	return (
		<Show when={activeSegment()}>
			<div
				class={`absolute inset-0 pointer-events-none flex ${positionClasses()} z-30 transition-all duration-150 ease-out`}
				style={{
					width: `${props.size.width}px`,
					height: `${props.size.height}px`,
				}}
			>
				<div class="animate-in fade-in zoom-in-95 duration-100">
					<KeycapPreviewCluster
						keys={parsedKeys()}
						style={(settings().style || "pbt") as KeycapStyle}
						theme={(settings().theme || "white") as KeycapTheme}
						showChassis={settings().showChassis ?? true}
						use3D={settings().keycapMode ?? true}
						scale={Math.min(1.2, Math.max(0.7, props.size.width / 1200))}
					/>
				</div>
			</div>
		</Show>
	);
}
