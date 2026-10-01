import { createMemo, Show } from "solid-js";
import { defaultKeyboardSettings, type KeycapStyle, type KeycapTheme } from "~/store/keyboard";
import { useEditorContext } from "./context";
import { KeycapPreviewCluster } from "./KeycapRenderer";

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

	const selectedSegment = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (selection?.type === "keyboard" && selection.indices.length > 0) {
			const index = selection.indices[0];
			return project.timeline?.keyboardSegments?.[index] ?? null;
		}
		return null;
	});

	const activeSegment = createMemo(() => {
		if (!settings().enabled || !isTrackEnabled()) return null;
		// If user selected a keyboard segment on timeline, show that one for live tweaking
		const selected = selectedSegment();
		if (selected) return selected;

		const time = currentAbsoluteTime();
		const segments = project.timeline?.keyboardSegments ?? [];
		return (
			segments.find((seg) => time >= seg.start && time <= seg.end) ?? null
		);
	});

	const parsedKeys = createMemo(() => {
		const seg = activeSegment();
		if (!seg) return [];
		const text = seg.displayText || "";
		if (text.includes("+")) {
			return text.split("+").map((s) => s.trim()).filter(Boolean);
		}
		if (text.includes(" ")) {
			return text.split(" ").map((s) => s.trim()).filter(Boolean);
		}
		return [text];
	});

	return (
		<Show when={activeSegment()}>
			<div
				class="absolute inset-0 pointer-events-none flex items-end justify-center pb-8 z-30 transition-all duration-150 ease-out"
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
						scale={Math.min(1.2, Math.max(0.7, props.size.width / 1200))}
					/>
				</div>
			</div>
		</Show>
	);
}
