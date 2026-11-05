import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { finishNativeWalk, projectSlug } from "./native-walk.mjs";

const bridge = fileURLToPath(new URL("./native-walk.mjs", import.meta.url));

// A settings folder of its own and a PATH holding only stub gh, bd and security, so nothing
// here reaches the network or the login Keychain.
function sandbox(t, { gh = "logged-in" } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-projects-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const config = path.join(root, "config");
	const bin = path.join(root, "bin");
	fs.mkdirSync(config);
	fs.mkdirSync(bin);
	const stub = (name, body) => {
		fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {
			mode: 0o755,
		});
	};
	stub("bd", 'echo "bd help"');
	stub("security", "exit 44");
	stub(
		"gh",
		gh === "logged-in"
			? [
					'if [ "$1" = auth ]; then echo "Logged in"; exit 0; fi',
					'if [ "$1" = repo ]; then echo \'[{"nameWithOwner":"acme/web"},{"nameWithOwner":"acme/api"}]\'; exit 0; fi',
					"exit 1",
				].join("\n")
			: 'echo "not logged in" >&2; exit 1',
	);
	const env = {
		HOME: root,
		USER: "tester",
		PATH: bin,
		CAP_UX_WALK_CONFIG_DIR: config,
	};
	const run = (command, request) => {
		let file = path.join(root, "unused.json");
		if (request !== undefined) {
			file = path.join(root, `${command}-request.json`);
			fs.writeFileSync(file, JSON.stringify(request));
		}
		return spawnSync(process.execPath, [bridge, command, file], {
			encoding: "utf8",
			timeout: 15000,
			env,
		});
	};
	const json = (command, request) => {
		const result = run(command, request);
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	};
	return { root, config, run, json };
}

test("save-project names a new project from its name and creates a new glossary", (t) => {
	const s = sandbox(t);
	fs.writeFileSync(
		path.join(s.config, "config.json"),
		JSON.stringify({ project: "acme-web" }),
	);
	assert.deepEqual(s.json("projects"), {
		version: 1,
		default: "acme-web",
		projects: [],
		problems: [],
		glossaries: [],
	});
	const saved = s.json("save-project", {
		create: true,
		project: {
			name: "Acme Web",
			glossary: "acme",
			tracker: {
				provider: "github",
				target: "acme/web",
				targetName: "acme/web",
			},
			sourceRoot: "~/code/acme",
			briefNotes: null,
			url: "https://acme.example",
		},
	});
	assert.equal(saved.id, "acme-web");
	assert.equal(saved.version, 1);
	assert.ok(fs.existsSync(path.join(s.config, "glossaries/acme.txt")));
	assert.deepEqual(
		JSON.parse(
			fs.readFileSync(path.join(s.config, "projects/acme-web.json"), "utf8"),
		),
		saved,
	);
	const again = s.json("save-project", {
		create: true,
		project: { name: "Acme Web", glossary: "acme" },
	});
	assert.equal(again.id, "acme-web-2");
	const list = s.json("projects");
	assert.equal(list.default, "acme-web");
	assert.deepEqual(list.projects.map((project) => project.id).sort(), [
		"acme-web",
		"acme-web-2",
	]);
	assert.deepEqual(list.glossaries, ["acme"]);
	// An edit keeps the id and replaces the fields.
	const edited = s.json("save-project", {
		project: { ...saved, name: "Acme Website", tracker: null },
	});
	assert.equal(edited.id, "acme-web");
	assert.equal(edited.tracker, null);
	assert.ok(
		s
			.json("projects")
			.projects.some(
				(project) =>
					project.id === "acme-web" && project.name === "Acme Website",
			),
	);
});

test("save-project reports the engine's validation and leaves nothing behind", (t) => {
	const s = sandbox(t);
	for (const [project, field] of [
		[{ name: "Bad", url: "not a url" }, "project.url"],
		[{ name: "  " }, "project.name"],
		[
			{ name: "Tracker", tracker: { provider: "github", target: "" } },
			"project.tracker.target",
		],
		[
			{ name: "Tracker", tracker: { provider: "jira", target: "X" } },
			"project.tracker.provider",
		],
		[{ name: "Glossary", glossary: "bad*name" }, "project.glossary"],
		[{ name: "Extra", secret: "x" }, "project.secret"],
	]) {
		const result = s.run("save-project", { create: true, project });
		assert.notEqual(result.status, 0, JSON.stringify(project));
		assert.match(result.stderr, new RegExp(field.replaceAll(".", "\\.")));
	}
	assert.ok(!fs.existsSync(path.join(s.config, "projects")));
	assert.ok(!fs.existsSync(path.join(s.config, "glossaries")));
	fs.mkdirSync(path.join(s.config, "projects"));
	s.json("save-project", { project: { id: "taken", name: "Taken" } });
	const duplicate = s.run("save-project", {
		create: true,
		project: { id: "taken", name: "Other" },
	});
	assert.notEqual(duplicate.status, 0);
	assert.match(duplicate.stderr, /already used/);
});

test("projects lists broken project files as problems and delete-project removes one", (t) => {
	const s = sandbox(t);
	fs.mkdirSync(path.join(s.config, "projects"));
	fs.writeFileSync(path.join(s.config, "projects/broken.json"), "{nope");
	fs.writeFileSync(
		path.join(s.config, "config.json"),
		JSON.stringify({ project: "keep" }),
	);
	s.json("save-project", { project: { id: "keep", name: "Keep" } });
	const list = s.json("projects");
	assert.deepEqual(
		list.projects.map((project) => project.id),
		["keep"],
	);
	assert.equal(list.problems.length, 1);
	assert.match(list.problems[0].file, /broken\.json$/);
	assert.match(list.problems[0].error, /not JSON/);
	assert.deepEqual(s.json("delete-project", { id: "keep" }), {
		deleted: "keep",
		wasDefault: true,
	});
	assert.ok(!fs.existsSync(path.join(s.config, "projects/keep.json")));
	const missing = s.run("delete-project", { id: "keep" });
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /No project "keep"/);
	assert.notEqual(s.run("delete-project", { id: "../config" }).status, 0);
	assert.ok(fs.existsSync(path.join(s.config, "config.json")));
});

test("trackers reports each plugin from the CLIs on PATH without a network", (t) => {
	const s = sandbox(t);
	const trackers = s.json("trackers");
	assert.deepEqual(
		trackers.map((tracker) => tracker.id),
		["beads", "github", "linear"],
	);
	const [beads, github, linear] = trackers;
	assert.equal(beads.ok, true);
	assert.equal(beads.needsKey, false);
	assert.equal(beads.keychainItem, null);
	assert.equal(github.ok, true);
	assert.equal(github.via, "gh");
	assert.equal(github.keychainItem, "ux-walk-github");
	assert.equal(linear.ok, false);
	assert.equal(linear.needsKey, true);
	assert.equal(linear.keyPresent, false);
	assert.match(linear.problem, /no Linear key/);
	assert.match(linear.keyUrl, /^https:\/\/linear\.app\//);

	const loggedOut = sandbox(t, { gh: "logged-out" });
	fs.rmSync(path.join(loggedOut.root, "bin/bd"));
	const [noBd, noGh] = loggedOut.json("trackers");
	assert.equal(noBd.ok, false);
	assert.match(noBd.problem, /bd is not installed/);
	assert.equal(noGh.ok, false);
	assert.match(noGh.problem, /gh is not logged in/);
});

test("targets lists a tracker's repos or folders and refuses unknown trackers", (t) => {
	const s = sandbox(t);
	assert.deepEqual(s.json("targets", { provider: "github" }), [
		{ id: "acme/web", name: "acme/web" },
		{ id: "acme/api", name: "acme/api" },
	]);
	const folder = path.join(s.root, "acme");
	fs.mkdirSync(folder);
	s.json("save-project", {
		project: { id: "acme", name: "Acme", sourceRoot: folder },
	});
	assert.deepEqual(s.json("targets", { provider: "beads" }), [
		{ id: folder, name: "acme" },
	]);
	const unknown = s.run("targets", { provider: "jira" });
	assert.notEqual(unknown.status, 0);
	assert.match(unknown.stderr, /unknown tracker "jira"/);
	const noKey = s.run("targets", { provider: "linear" });
	assert.notEqual(noKey.status, 0);
	assert.match(noKey.stderr, /no Linear key/);
});

test("project ids are slugs that avoid saved ones", () => {
	assert.equal(projectSlug("Acme Web!"), "acme-web");
	assert.equal(projectSlug("Café Ünïcode"), "cafe-unicode");
	assert.equal(projectSlug("  "), "project");
	assert.equal(
		projectSlug("Acme", (id) => ["acme", "acme-2"].includes(id)),
		"acme-3",
	);
	assert.match(projectSlug("x".repeat(200)), /^[a-z0-9][a-z0-9-]{0,63}$/);
});

function diatribe(t, project) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-project-walk-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = path.join(root, "original.cap");
	const directory = path.join(root, "walk");
	fs.mkdirSync(path.join(source, "content"), { recursive: true });
	fs.mkdirSync(directory);
	fs.writeFileSync(
		path.join(source, "recording-meta.json"),
		JSON.stringify({ pretty_name: "Talk", fps: 30, sample_rate: 48000 }),
	);
	fs.writeFileSync(path.join(source, "content/output.mp4"), "instant");
	const file = path.join(directory, "native-walk.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 1,
			state: "complete",
			startedAtMs: 100000,
			durationMs: 10000,
			sourceProject: source,
			request: {
				directory,
				topic: "Diatribe",
				url: "",
				speakers: ["Tester"],
				kind: "diatribe",
				...(project === undefined ? {} : { project }),
			},
			events: [{ kind: "note", text: "Importer first", offsetMs: 1500 }],
		}),
	);
	const config = path.join(root, "config");
	fs.mkdirSync(path.join(config, "projects"), { recursive: true });
	const glossary = path.join(root, "acme.txt");
	fs.writeFileSync(glossary, "Acme: Akme\n");
	const code = path.join(root, "code");
	fs.mkdirSync(code);
	fs.writeFileSync(
		path.join(config, "projects/acme.json"),
		JSON.stringify({
			version: 1,
			id: "acme",
			name: "Acme",
			glossary,
			tracker: null,
			sourceRoot: code,
			briefNotes: path.join(root, "acme-notes.md"),
			url: null,
		}),
	);
	return { root, file, directory, config, glossary, code };
}

function stubs(seen) {
	return {
		client: {},
		exportInstant: async (_client, _project, output) => {
			fs.writeFileSync(output, "instant export");
			return { durationS: 10 };
		},
		clip: async () => {
			throw new Error("One chapter reuses the whole export");
		},
		prepareAudio: async () => null,
		processChapter: async (directory, cfg) => {
			seen.push({
				chapter: JSON.parse(
					fs.readFileSync(path.join(directory, "chapter.json"), "utf8"),
				),
				cfg,
			});
			return {};
		},
		writeIndex: () => {},
		writeReport: () => {},
	};
}

test("a recording's project reaches session.json and chapter.json and layers its settings", async (t) => {
	const f = diatribe(t, "acme");
	const seen = [];
	await finishNativeWalk(
		f.file,
		{
			transcriber: "none",
			brief: false,
			configDir: f.config,
			sourceRoot: "/elsewhere",
		},
		stubs(seen),
	);
	const session = JSON.parse(
		fs.readFileSync(path.join(f.directory, "session.json"), "utf8"),
	);
	assert.equal(session.project, "acme");
	assert.ok(session.glossaries.includes(f.glossary));
	assert.ok(seen.length > 0);
	for (const { chapter, cfg } of seen) {
		assert.equal(chapter.project, "acme");
		assert.equal(cfg.project, "acme");
		assert.equal(cfg.sourceRoot, f.code);
		assert.equal(cfg.briefNotes, path.join(f.root, "acme-notes.md"));
		assert.ok(cfg.glossary.split(",").includes(f.glossary));
	}
	// The engine's own lookup now finds it.
	const { sessionProject } = await import(
		new URL("../../../vendor/ux-walk/src/projects.mjs", import.meta.url)
	);
	assert.equal(
		sessionProject(f.directory, { configDir: f.config }).name,
		"Acme",
	);

	// Moved to no project after it was made: reprocessing keeps that choice.
	fs.writeFileSync(
		path.join(f.directory, "session.json"),
		JSON.stringify({ ...session, project: null }),
	);
	fs.rmSync(path.join(f.directory, "processing.json"), { force: true });
	const again = [];
	await finishNativeWalk(
		f.file,
		{
			transcriber: "none",
			brief: false,
			configDir: f.config,
			sourceRoot: "/elsewhere",
		},
		stubs(again),
	);
	const moved = JSON.parse(
		fs.readFileSync(path.join(f.directory, "session.json"), "utf8"),
	);
	assert.equal(moved.project, null);
	assert.equal(again[0].cfg.sourceRoot, "/elsewhere");
});

test("a recording without a project, or with a deleted one, processes as before", async (t) => {
	for (const project of [undefined, "gone"]) {
		const f = diatribe(t, project);
		const seen = [];
		await finishNativeWalk(
			f.file,
			{
				transcriber: "none",
				brief: false,
				configDir: f.config,
				sourceRoot: "/elsewhere",
			},
			stubs(seen),
		);
		const session = JSON.parse(
			fs.readFileSync(path.join(f.directory, "session.json"), "utf8"),
		);
		assert.equal(session.project, project ?? null);
		assert.equal(seen[0].cfg.sourceRoot, "/elsewhere");
		assert.deepEqual(session.glossaries, seen[0].chapter.glossaries);
	}
});
