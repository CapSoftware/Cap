import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { stat } from "@tauri-apps/plugin-fs";
import type { Accessor } from "solid-js";
import { createTauriEventListener } from "./createEventListener";

export async function recordingThumbnailUrl(path: string): Promise<string> {
	for (const name of ["preview.jpg", "display.jpg"]) {
		const file = `${path}/screenshots/${name}`;
		try {
			const metadata = await stat(file);
			if (metadata.isFile) {
				return `${convertFileSrc(file)}?v=${metadata.mtime?.getTime() ?? 0}-${metadata.size}`;
			}
		} catch {}
	}
	return convertFileSrc(`${path}/screenshots/display.jpg`);
}

export function createRecordingThumbnail(path: Accessor<string | undefined>) {
	const client = useQueryClient();
	const thumbnail = createQuery(() => ({
		queryKey: ["recording-thumbnail", path()] as const,
		queryFn: ({ queryKey }) => recordingThumbnailUrl(queryKey[1] ?? ""),
		enabled: !!path(),
		placeholderData: path()
			? convertFileSrc(`${path()}/screenshots/display.jpg`)
			: undefined,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: "always" as const,
	}));
	createTauriEventListener<string>(
		{ listen: (callback) => listen("recording-thumbnail-changed", callback) },
		(changedPath) => {
			if (changedPath === path()) {
				void client.invalidateQueries({
					queryKey: ["recording-thumbnail", changedPath],
				});
			}
		},
	);
	return () => (path() ? thumbnail.data : undefined);
}
