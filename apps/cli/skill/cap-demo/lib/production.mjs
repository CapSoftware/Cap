import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
	exportCap,
	probeVideo,
	renderFilmcraft,
	renderGraphic,
} from "./production-tools.mjs";

const digest = (value) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = (file, value) =>
	fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
		flag: "wx",
	});

async function exists(file) {
	try {
		await fs.lstat(file);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

async function hashFile(file) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}

async function destinationPath(file) {
	try {
		return await fs.realpath(file);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return path.join(
			await destinationPath(path.dirname(file)),
			path.basename(file),
		);
	}
}

async function copyRegular(source, destination) {
	const info = await fs.lstat(source);
	if (info.isSymbolicLink())
		throw new Error("Production sources cannot contain a symbolic link");
	if (info.isDirectory()) {
		await fs.mkdir(destination);
		for (const name of await fs.readdir(source))
			await copyRegular(path.join(source, name), path.join(destination, name));
	} else if (info.isFile())
		await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
	else throw new Error("Production sources must be regular files");
}

async function inventory(root, folder = "assets") {
	const entries = [];
	for (const name of (await fs.readdir(path.join(root, folder))).sort()) {
		const relative = `${folder}/${name}`;
		const file = path.join(root, relative);
		const info = await fs.lstat(file);
		if (info.isDirectory()) entries.push(...(await inventory(root, relative)));
		else
			entries.push({
				path: relative,
				bytes: info.size,
				sha256: await hashFile(file),
			});
	}
	return entries;
}

export function parseCaptions(srt, offset = 0) {
	const seconds = (value) =>
		value
			.split(/[:,.]/)
			.map(Number)
			.reduce((total, n, i) => total + n * [3600, 60, 1, 0.001][i], 0);
	return srt
		.replaceAll("\r", "")
		.trim()
		.split(/\n\s*\n/)
		.filter(Boolean)
		.map((block) => {
			const lines = block.split("\n");
			const index = lines.findIndex((line) => line.includes("-->"));
			const match = lines[index]?.match(
				/^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[,.]\d{3})/,
			);
			if (!match || index === lines.length - 1)
				throw new Error("Invalid SRT captions");
			const start = seconds(match[1]) + offset;
			const end = seconds(match[2]) + offset;
			if (!(start >= 0 && end > start))
				throw new Error("Invalid caption clock");
			return { start, end, text: lines.slice(index + 1).join("\n") };
		});
}

export async function prepareProduction(input, output, options = {}) {
	input = path.resolve(input);
	output = path.resolve(output);
	if (await exists(output))
		throw new Error(
			"Production destination already exists; choose a new folder",
		);
	if ((await fs.lstat(input)).isSymbolicLink())
		throw new Error("Production source cannot be a symbolic link");
	let video = input;
	let capProject;
	let journal;
	if (path.basename(input) === "native-walk.json") {
		journal = await readJson(input);
		if (journal.state !== "complete")
			throw new Error("Finish the walk before preparing a demo");
		video = path.join(path.dirname(input), "media/video.mp4");
		capProject = path.join(path.dirname(input), "media/source.cap");
	} else if ((await fs.stat(input)).isDirectory()) {
		if (path.extname(input) !== ".cap")
			throw new Error(
				"Select a .cap recording, native-walk.json or video file",
			);
		capProject = input;
	}
	if (capProject) {
		const source = await fs.realpath(capProject);
		const destination = await destinationPath(output);
		if (
			destination === source ||
			destination.startsWith(`${source}${path.sep}`)
		)
			throw new Error(
				"Production destination must be outside the source project",
			);
	}
	await fs.mkdir(path.dirname(output), { recursive: true });
	const staging = await fs.mkdtemp(`${output}.preparing-`);
	try {
		await fs.mkdir(path.join(staging, "assets"));
		if (capProject)
			await copyRegular(capProject, path.join(staging, "assets/source.cap"));
		const target = path.join(staging, "assets/video.mp4");
		if (capProject === input)
			await (options.exportCap || exportCap)(
				path.join(staging, "assets/source.cap"),
				target,
				options.cap,
			);
		else await copyRegular(video, target);
		const media = await (options.probe || probeVideo)(target);
		let captions = [];
		if (options.captions)
			captions = parseCaptions(await fs.readFile(options.captions, "utf8"));
		else if (journal) {
			const session = await readJson(
				path.join(path.dirname(input), "session.json"),
			);
			for (const chapter of session.chapters) {
				if (
					typeof chapter.dir !== "string" ||
					path.isAbsolute(chapter.dir) ||
					chapter.dir.split(/[\\/]/).includes("..")
				)
					throw new Error("Invalid chapter path");
				const file = path.join(
					path.dirname(input),
					chapter.dir,
					"transcript.srt",
				);
				if (await exists(file))
					captions.push(
						...parseCaptions(
							await fs.readFile(file, "utf8"),
							(chapter.startMs - journal.startedAtMs) / 1000,
						),
					);
			}
		}
		await writeJson(path.join(staging, "assets/captions.json"), captions);
		const project = {
			schemaVersion: 1,
			title:
				journal?.request.topic || path.basename(input, path.extname(input)),
			video: "assets/video.mp4",
			sourceProject: capProject ? "assets/source.cap" : null,
			media,
			captionPrecision: "cue",
			sourceClock: "prepared-video",
			notes: journal?.events || [],
			assets: await inventory(staging),
		};
		project.revision = digest(project);
		await writeJson(path.join(staging, "project.json"), project);
		await writeJson(path.join(staging, "edit.json"), {
			schemaVersion: 1,
			sourceRevision: project.revision,
			clips: [{ inFrame: 0, outFrame: media.frames }],
			titleCard: null,
		});
		await fs.rename(staging, output);
		return {
			directory: output,
			project: path.join(output, "project.json"),
			edit: path.join(output, "edit.json"),
		};
	} catch (error) {
		await fs.rm(staging, { recursive: true, force: true });
		throw error;
	}
}

async function localFile(root, relative) {
	if (
		typeof relative !== "string" ||
		path.isAbsolute(relative) ||
		relative.split(/[\\/]/).includes("..")
	)
		throw new Error("Invalid production asset path");
	const realRoot = await fs.realpath(root);
	const file = path.join(root, relative);
	if (!(await fs.realpath(file)).startsWith(`${realRoot}${path.sep}`))
		throw new Error("Production asset escapes its project");
	if (!(await fs.lstat(file)).isFile())
		throw new Error("Production asset is not a regular file");
	return file;
}

export async function readProduction(root) {
	const project = await readJson(path.join(root, "project.json"));
	const { revision, ...data } = project;
	if (project.schemaVersion !== 1 || digest(data) !== revision)
		throw new Error(
			"Production manifest changed; prepare a new source revision",
		);
	for (const asset of project.assets) {
		if ((await hashFile(await localFile(root, asset.path))) !== asset.sha256)
			throw new Error(`Production source changed: ${asset.path}`);
	}
	const edit = await readJson(path.join(root, "edit.json"));
	validateEdit(edit, project);
	return { project, edit };
}

export function validateEdit(edit, project) {
	if (edit.schemaVersion !== 1 || edit.sourceRevision !== project.revision)
		throw new Error("Edit source revision is stale");
	if (
		!Array.isArray(edit.clips) ||
		edit.clips.length === 0 ||
		edit.clips.length > 1000
	)
		throw new Error("Choose between one and 1000 clips");
	let frames = 0;
	for (const clip of edit.clips) {
		if (
			!Number.isSafeInteger(clip.inFrame) ||
			!Number.isSafeInteger(clip.outFrame) ||
			clip.inFrame < 0 ||
			clip.outFrame <= clip.inFrame ||
			clip.outFrame > project.media.frames
		)
			throw new Error("Clip range is outside the source video");
		frames += clip.outFrame - clip.inFrame;
	}
	if (edit.titleCard) {
		const graphic = edit.titleCard;
		if (
			typeof graphic.title !== "string" ||
			!graphic.title.trim() ||
			graphic.title.length > 90 ||
			(graphic.subtitle &&
				(typeof graphic.subtitle !== "string" ||
					graphic.subtitle.length > 160)) ||
			!Number.isSafeInteger(graphic.durationFrames) ||
			graphic.durationFrames < 1 ||
			graphic.durationFrames > project.media.fps * 15 ||
			[graphic.accent, graphic.background].some(
				(color) => color !== undefined && !/^#[\da-f]{6}$/i.test(color),
			)
		)
			throw new Error(
				"Invalid graphic: use a short title and a duration of at most 15 seconds",
			);
		frames += graphic.durationFrames;
	}
	if (frames / project.media.fps > 21600)
		throw new Error("Clip output exceeds six hours");
	return frames;
}

export function projectCaptions(captions, edit, fps) {
	const result = [];
	let cursor = (edit.titleCard?.durationFrames || 0) / fps;
	for (const clip of edit.clips) {
		const start = clip.inFrame / fps;
		const end = clip.outFrame / fps;
		for (const cue of captions) {
			const a = Math.max(start, cue.start);
			const b = Math.min(end, cue.end);
			if (b > a && (cue.start < start - 0.5 / fps || cue.end > end + 0.5 / fps))
				throw new Error(
					"A cut falls inside a caption cue. Keep that spoken phrase complete; word-level cuts are not available in this pilot.",
				);
			if (b > a)
				result.push({
					start: cursor + a - start,
					end: cursor + b - start,
					text: cue.text,
				});
		}
		cursor += end - start;
	}
	return result;
}

function srt(captions) {
	const clock = (seconds) => {
		const ms = Math.round(seconds * 1000);
		return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
	};
	return captions
		.map(
			(cue, i) =>
				`${i + 1}\n${clock(cue.start)} --> ${clock(cue.end)}\n${cue.text}\n`,
		)
		.join("\n");
}

export async function renderProduction(root, options = {}) {
	root = path.resolve(root);
	const { project, edit } = await readProduction(root);
	const directory = path.join(root, "renders", randomUUID());
	await fs.mkdir(directory, { recursive: true });
	await writeJson(path.join(directory, "edit.json"), edit);
	try {
		if (edit.titleCard)
			await renderGraphic(
				directory,
				edit.titleCard,
				project.media,
				options.effectcraft || process.env.EFFECTCRAFT_BIN || "effectcraft-cli",
			);
		const captions = projectCaptions(
			await readJson(path.join(root, "assets/captions.json")),
			edit,
			project.media.fps,
		);
		await fs.writeFile(path.join(directory, "captions.srt"), srt(captions));
		await (options.renderFilmcraft || renderFilmcraft)(
			directory,
			path.relative(directory, path.join(root, project.video)),
			edit,
			project.media,
			options.filmcraft || process.env.FILMCRAFT_BIN || "filmcraft-cli",
			captions.length > 0,
		);
		const rendered = await probeVideo(path.join(directory, "demo.mp4"));
		const expectedFrames = validateEdit(edit, project);
		if (
			Math.abs(
				rendered.frames / rendered.fps - expectedFrames / project.media.fps,
			) >
				2 / project.media.fps ||
			(project.media.hasAudio && !rendered.hasAudio)
		)
			throw new Error(
				"Rendered duration or audio does not match the edit plan",
			);
		let cursor = edit.titleCard?.durationFrames || 0;
		const mapping = edit.clips.map((clip) => {
			const row = {
				sourceInFrame: clip.inFrame,
				sourceOutFrame: clip.outFrame,
				outputInFrame: cursor,
				outputOutFrame: cursor + clip.outFrame - clip.inFrame,
			};
			cursor = row.outputOutFrame;
			return row;
		});
		await writeJson(path.join(directory, "source-map.json"), {
			fps: project.media.fps,
			sourceVideo: `../../${project.video}`,
			sourceRevision: project.revision,
			clips: mapping,
		});
		await readProduction(root);
		const escape = (value) =>
			String(value).replace(
				/[&<>"']/g,
				(c) =>
					({
						"&": "&amp;",
						"<": "&lt;",
						">": "&gt;",
						'"': "&quot;",
						"'": "&#39;",
					})[c],
			);
		await fs.writeFile(
			path.join(directory, "review.html"),
			`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(project.title)} · Demo review</title><style>body{font:16px system-ui;background:#fafafa;color:#20242c;max-width:1000px;margin:40px auto;padding:24px}video{width:100%;background:#111;border-radius:12px}a{color:#2467d5}li{margin:12px 0}</style><h1>${escape(project.title)}</h1><h2>Demo draft</h2><video controls src="demo.mp4"></video><p><a href="draft.fcproj">Editable FilmCraft project</a> · ${edit.titleCard ? '<a href="graphic.ecproj">Editable EffectCraft graphic</a> · ' : ""}<a href="captions.srt">Captions</a> · <a href="source-map.json">Source timing</a></p><h2>Prepared source video</h2><video controls preload="none" src="../../${escape(project.video)}"></video><p>Captions retain cue-level timing. This draft preserves the original recording and its evidence.</p><h2>Source notes</h2><ul>${project.notes.map((note) => `<li>${(note.offsetMs / 1000).toFixed(1)}s · ${escape(note.text)}</li>`).join("")}</ul></html>`,
			{ mode: 0o600 },
		);
		await writeJson(path.join(directory, "result.json"), {
			state: "ready",
			sourceRevision: project.revision,
			media: rendered,
		});
		return {
			directory,
			video: path.join(directory, "demo.mp4"),
			review: path.join(directory, "review.html"),
			project: path.join(directory, "draft.fcproj"),
		};
	} catch (error) {
		await writeJson(path.join(directory, "result.json"), {
			state: "failed",
			error: error.message,
		});
		throw new Error(`${error.message}\nDraft files retained at ${directory}`, {
			cause: error,
		});
	}
}
