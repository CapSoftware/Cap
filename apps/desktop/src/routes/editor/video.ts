import {
	commands,
	type ImportedEditorVideo,
	type VideoSegment,
} from "~/utils/tauri";

export type { VideoSegment } from "~/utils/tauri";

export async function pickVideo(
	sourcePath?: string,
): Promise<ImportedEditorVideo | null> {
	const source =
		sourcePath ??
		(await import("@tauri-apps/plugin-dialog").then(({ open }) =>
			open({
				multiple: false,
				directory: false,
				filters: [
					{
						name: "Videos",
						extensions: [
							"mp4",
							"mov",
							"avi",
							"mkv",
							"webm",
							"wmv",
							"m4v",
							"flv",
						],
					},
				],
			}),
		));
	if (typeof source !== "string") return null;
	return commands.importEditorVideo(source);
}

export function defaultVideoSegment(
	asset: ImportedEditorVideo,
	start: number,
	track: number,
	output: { width: number; height: number },
): VideoSegment {
	const scale = Math.min(
		output.width / Math.max(1, asset.width),
		output.height / Math.max(1, asset.height),
	);
	return {
		start,
		end: start + asset.duration,
		track,
		enabled: true,
		path: asset.path,
		name: asset.name,
		sourceStart: 0,
		sourceDuration: asset.duration,
		muted: !asset.hasAudio,
		volumeDb: 0,
		center: { x: 0.5, y: 0.5 },
		size: {
			x: (asset.width * scale) / output.width,
			y: (asset.height * scale) / output.height,
		},
		opacity: 1,
		rotation: 0,
		rounding: 0,
		flipX: false,
		flipY: false,
		lockAspect: true,
	};
}
