import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	prepareProduction,
	projectCaptions,
	readProduction,
	renderProduction,
	validateEdit,
} from "./production.mjs";

const media = { width: 640, height: 360, fps: 30, frames: 300, hasAudio: true };

async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "demo-production-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const source = path.join(root, "Original demo.mp4");
	await fs.writeFile(source, "untouched recording");
	return { root, source, output: path.join(root, "production") };
}

test("a production bundle moves independently and leaves its source untouched", async (t) => {
	const f = await fixture(t);
	await prepareProduction(f.source, f.output, { probe: async () => media });
	const moved = path.join(f.root, "moved project");
	await fs.rename(f.output, moved);
	const { project, edit } = await readProduction(moved);
	assert.equal(project.schemaVersion, 1);
	assert.equal(project.media.frames, 300);
	assert.deepEqual(edit.clips, [{ inFrame: 0, outFrame: 300 }]);
	assert.equal(await fs.readFile(f.source, "utf8"), "untouched recording");
	assert.equal(
		await fs.readFile(path.join(moved, project.video), "utf8"),
		"untouched recording",
	);
	assert.equal(JSON.stringify(project).includes(f.root), false);
});

test("preparation refuses existing destinations and linked source media", async (t) => {
	const f = await fixture(t);
	await fs.mkdir(f.output);
	await fs.writeFile(path.join(f.output, "keep.txt"), "keep");
	await assert.rejects(prepareProduction(f.source, f.output), /exists/);
	assert.equal(
		await fs.readFile(path.join(f.output, "keep.txt"), "utf8"),
		"keep",
	);
	const linked = path.join(f.root, "linked.mp4");
	await fs.symlink(f.source, linked);
	await assert.rejects(
		prepareProduction(linked, path.join(f.root, "other")),
		/symbolic link/,
	);
});

test("a destination alias cannot place the production bundle inside its source", async (t) => {
	const f = await fixture(t);
	const source = path.join(f.root, "original.cap");
	const alias = path.join(f.root, "source alias");
	await fs.mkdir(source);
	await fs.symlink(source, alias, "dir");
	await assert.rejects(
		prepareProduction(source, path.join(alias, "draft")),
		/outside/,
	);
	assert.deepEqual(await fs.readdir(source), []);
});

test("modified media and stale edit revisions fail before editing starts", async (t) => {
	const f = await fixture(t);
	await prepareProduction(f.source, f.output, { probe: async () => media });
	const { project, edit } = await readProduction(f.output);
	assert.throws(
		() => validateEdit({ ...edit, sourceRevision: "old" }, project),
		/revision/,
	);
	await fs.appendFile(path.join(f.output, project.video), "changed");
	await assert.rejects(readProduction(f.output), /changed/);
});

test("captions follow reordered source ranges and a graphic insert on the same clock", () => {
	const edit = {
		clips: [
			{ inFrame: 150, outFrame: 240 },
			{ inFrame: 30, outFrame: 90 },
		],
		titleCard: { durationFrames: 60 },
	};
	const result = projectCaptions(
		[
			{ start: 1.5, end: 2.5, text: "First idea" },
			{ start: 5.5, end: 7, text: "Stronger opening" },
			{ start: 8.5, end: 9.5, text: "Discarded retake" },
		],
		edit,
		30,
	);
	assert.deepEqual(result, [
		{ start: 2.5, end: 4, text: "Stronger opening" },
		{ start: 5.5, end: 6.5, text: "First idea" },
	]);
});

test("edit plans reject impossible cuts and unbounded graphics", () => {
	const project = { revision: "source", media };
	const base = {
		schemaVersion: 1,
		sourceRevision: "source",
		clips: [{ inFrame: 0, outFrame: 300 }],
		titleCard: null,
	};
	for (const clips of [
		[],
		[{ inFrame: -1, outFrame: 20 }],
		[{ inFrame: 10, outFrame: 10 }],
		[{ inFrame: 0, outFrame: 301 }],
		[{ inFrame: 0.5, outFrame: 20 }],
	]) {
		assert.throws(() => validateEdit({ ...base, clips }, project), /clip/i);
	}
	assert.throws(
		() =>
			validateEdit(
				{ ...base, titleCard: { title: "Test", durationFrames: Infinity } },
				project,
			),
		/graphic/i,
	);
});

test("cue captions refuse a speech cut whose words cannot be timed reliably", () => {
	assert.throws(
		() =>
			projectCaptions(
				[{ start: 1, end: 2, text: "Keep this complete sentence" }],
				{ clips: [{ inFrame: 45, outFrame: 90 }], titleCard: null },
				30,
			),
		/caption cue/,
	);
});

test("an editor failure retains an inspectable draft and preserves original media", async (t) => {
	const f = await fixture(t);
	await prepareProduction(f.source, f.output, { probe: async () => media });
	await assert.rejects(
		renderProduction(f.output, {
			renderFilmcraft: async () => {
				throw new Error("Synthetic editor failure");
			},
		}),
		/Synthetic editor failure/,
	);
	const [draft] = await fs.readdir(path.join(f.output, "renders"));
	const result = JSON.parse(
		await fs.readFile(
			path.join(f.output, "renders", draft, "result.json"),
			"utf8",
		),
	);
	assert.equal(result.state, "failed");
	assert.equal(await fs.readFile(f.source, "utf8"), "untouched recording");
	await readProduction(f.output);
});
