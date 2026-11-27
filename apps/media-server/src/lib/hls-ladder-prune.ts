import { readFile, stat, writeFile } from "node:fs/promises";
import { HLS_LADDER_MASTER_PLAYLIST, hlsSegmentDurations } from "./hls-ladder";
import type { EncodedHlsLadder } from "./hls-ladder-encode";

export interface RungBitrate {
	name: string;
	pixels: number;
	averageBitrate: number;
}

export function averageBitrate(bytes: number, seconds: number): number {
	if (!(seconds > 0)) {
		throw new Error("HLS ladder rendition has no duration");
	}
	return (bytes * 8) / seconds;
}

// On screen text a downscaled rendition can cost more bits than the one above
// it under a constant quality encode, so a player would switch down to a
// smaller picture that saves nothing.
export function invertedRungs(rungs: RungBitrate[]): string[] {
	const [top, ...lower] = [...rungs].sort((a, b) => b.pixels - a.pixels);
	if (!top) return [];
	const pruned: string[] = [];
	let kept = top;
	for (const rung of lower) {
		if (rung.averageBitrate >= kept.averageBitrate) {
			pruned.push(rung.name);
		} else {
			kept = rung;
		}
	}
	return pruned;
}

export function removeHlsMasterVariants(
	master: string,
	playlists: ReadonlySet<string>,
): string {
	const lines = master.split(/\r?\n/);
	const out: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.trim().startsWith("#EXT-X-STREAM-INF:")) {
			let next = index + 1;
			while (next < lines.length && (lines[next] ?? "").trim() === "") next++;
			if (playlists.has((lines[next] ?? "").trim())) {
				index = next;
				continue;
			}
		}
		out.push(line);
	}
	return out.join("\n");
}

export async function pruneInvertedHlsRungs(
	ladder: EncodedHlsLadder,
): Promise<{ ladder: EncodedHlsLadder; pruned: string[] }> {
	const pathOf = (name: string) => {
		const file = ladder.files.find((candidate) => candidate.name === name);
		if (!file) throw new Error(`HLS ladder is missing ${name}`);
		return file.path;
	};
	const rungs: RungBitrate[] = [];
	for (const rendition of ladder.result.renditions) {
		const playlist = await readFile(pathOf(rendition.playlist), "utf8");
		const seconds = hlsSegmentDurations(playlist).reduce(
			(total, duration) => total + duration,
			0,
		);
		rungs.push({
			name: rendition.name,
			pixels: (rendition.width ?? 0) * (rendition.height ?? 0),
			averageBitrate: averageBitrate(rendition.bytes, seconds),
		});
	}
	const pruned = invertedRungs(rungs);
	if (pruned.length === 0) return { ladder, pruned };

	const prunedSet = new Set(pruned);
	const dropped = ladder.result.renditions.filter((rendition) =>
		prunedSet.has(rendition.name),
	);
	const droppedFiles = new Set(
		dropped.flatMap((rendition) => [rendition.playlist, rendition.media]),
	);
	const masterPath = pathOf(HLS_LADDER_MASTER_PLAYLIST);
	await writeFile(
		masterPath,
		removeHlsMasterVariants(
			await readFile(masterPath, "utf8"),
			new Set(dropped.map((rendition) => rendition.playlist)),
		),
	);
	const masterBytes = (await stat(masterPath)).size;

	return {
		ladder: {
			...ladder,
			files: ladder.files
				.filter((file) => !droppedFiles.has(file.name))
				.map((file) =>
					file.name === HLS_LADDER_MASTER_PLAYLIST
						? { ...file, bytes: masterBytes }
						: file,
				),
			result: {
				...ladder.result,
				renditions: ladder.result.renditions.filter(
					(rendition) => !prunedSet.has(rendition.name),
				),
			},
		},
		pruned,
	};
}
