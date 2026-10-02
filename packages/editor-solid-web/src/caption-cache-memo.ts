import { $PROXY, createMemo, createRoot } from "solid-js";
import {
	createEditorCaptionCache,
	type EditorCaptionCache,
} from "../../../apps/web/lib/editor-caption-transport";

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class EditorCaptionCacheMemo {
	private tracked: {
		sourceSegments: unknown[];
		trackSegments: unknown[];
		read: () => Promise<EditorCaptionCache | null>;
		dispose: () => void;
	} | null = null;

	get(config: unknown): Promise<EditorCaptionCache | null> {
		const captions = asRecord(config) ? config.captions : null;
		const timeline = asRecord(config) ? config.timeline : null;
		const sourceSegments = asRecord(captions) ? captions.segments : null;
		const trackSegments = asRecord(timeline) ? timeline.captionSegments : null;
		if (
			!Array.isArray(sourceSegments) ||
			!Array.isArray(trackSegments) ||
			!($PROXY in sourceSegments) ||
			!($PROXY in trackSegments)
		) {
			this.dispose();
			return createEditorCaptionCache(config);
		}
		if (
			this.tracked?.sourceSegments !== sourceSegments ||
			this.tracked.trackSegments !== trackSegments
		) {
			this.dispose();
			this.tracked = createRoot((dispose) => ({
				sourceSegments,
				trackSegments,
				read: createMemo(() => createEditorCaptionCache(config)),
				dispose,
			}));
		}
		return this.tracked.read();
	}

	dispose() {
		this.tracked?.dispose();
		this.tracked = null;
	}
}
