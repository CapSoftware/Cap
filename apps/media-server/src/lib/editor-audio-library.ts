import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEditorFile as runFile } from "./editor-process";

const MAX_TRACK_BYTES = 32 * 1024 * 1024;
const LOCAL_MUSIC_DIR = fileURLToPath(
	new URL("../../../../apps/desktop/src/assets/music/", import.meta.url),
);
const tracks = [
	{ id: "lofi-beats-mirostar", name: "Lofi Beats", category: "Lo-Fi" },
	{ id: "raindrops-lofi-sleep-bluelike", name: "Raindrops", category: "Lo-Fi" },
	{
		id: "sunday-mood-lofi-cafe-upbeat-bluelike",
		name: "Sunday Mood",
		category: "Lo-Fi",
	},
	{
		id: "good-night-lofi-cozy-chill-fassounds",
		name: "Good Night",
		category: "Lo-Fi",
	},
	{
		id: "ambient-trap-empty-streets-dreamstate-openmindaudio",
		name: "Empty Streets",
		category: "Lo-Fi",
	},
	{
		id: "lofi-study-calm-peaceful-chill-hop-fassounds",
		name: "Study",
		category: "Lo-Fi",
	},
	{ id: "lofi-cinematic-pulsebox", name: "Cinematic", category: "Lo-Fi" },
	{ id: "lofi-hip-hop-leberch", name: "Hip Hop", category: "Lo-Fi" },
	{ id: "cassette-retrositive", name: "Cassette", category: "Lo-Fi" },
	{ id: "lofi-smooth-pulsebox", name: "Smooth", category: "Lo-Fi" },
] as const;

function musicDirectory() {
	return process.env.CAP_WEB_EDITOR_MUSIC_DIR ?? LOCAL_MUSIC_DIR;
}

function libraryTrack(id: unknown) {
	if (typeof id !== "string") throw new Error("Invalid library track");
	const track = tracks.find((item) => item.id === id);
	if (!track) throw new Error("Unknown library track");
	return track;
}

export function listEditorAudioLibrary() {
	return tracks.map((track) => ({ ...track }));
}

async function stageLibraryTrack(projectPath: string, id: string) {
	const track = libraryTrack(id);
	const source = join(musicDirectory(), `${track.id}.mp3`);
	const sourceStats = await lstat(source);
	if (
		!sourceStats.isFile() ||
		sourceStats.size < 1 ||
		sourceStats.size > MAX_TRACK_BYTES
	) {
		throw new Error("Bundled library track is unavailable");
	}
	const audioDir = join(projectPath, "assets", "audio");
	await mkdir(audioDir, { recursive: true, mode: 0o700 });
	const fileName = `library-${track.id}.mp3`;
	const destination = join(audioDir, fileName);
	const existing = await lstat(destination).catch(() => null);
	if (!existing?.isFile() || existing.size !== sourceStats.size) {
		const temporary = join(audioDir, `${randomUUID()}.mp3`);
		try {
			await copyFile(source, temporary, constants.COPYFILE_EXCL);
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true });
		}
	}
	return { track, destination, path: `assets/audio/${fileName}` };
}

export async function addEditorAudioLibraryTrack(
	projectPath: string,
	id: unknown,
) {
	const staged = await stageLibraryTrack(projectPath, libraryTrack(id).id);
	let duration = 0;
	try {
		const { stdout } = await runFile(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"default=noprint_wrappers=1:nokey=1",
				staged.destination,
			],
			{ timeout: 10_000, maxBuffer: 1024 },
		);
		const parsed = Number(stdout.trim());
		if (Number.isFinite(parsed) && parsed > 0) duration = parsed;
	} catch {
		duration = 0;
	}
	return { path: staged.path, name: staged.track.name, duration };
}

export async function stageSavedEditorAudioLibrary(
	projectPath: string,
	projectConfig?: Record<string, unknown>,
) {
	const timeline = projectConfig?.timeline;
	if (typeof timeline !== "object" || timeline === null) return;
	if (!("audioSegments" in timeline)) return;
	const segments = timeline.audioSegments;
	if (!Array.isArray(segments)) return;
	const ids = new Set<string>();
	for (const segment of segments) {
		if (typeof segment !== "object" || segment === null) continue;
		if (!("path" in segment) || typeof segment.path !== "string") continue;
		const match = /^assets\/audio\/library-([a-z0-9-]+)\.mp3$/.exec(
			segment.path,
		);
		if (match && tracks.some((track) => track.id === match[1])) {
			ids.add(match[1]);
		}
	}
	await Promise.all([...ids].map((id) => stageLibraryTrack(projectPath, id)));
}
