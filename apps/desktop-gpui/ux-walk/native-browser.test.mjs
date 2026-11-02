import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectBrowserEvidence } from "./browser-evidence.mjs";
import {
	flushNativeNotes,
	NativeBrowserEvidence,
	OwnedWindowEvents,
} from "./native-browser.mjs";
import { finishNativeWalk, nativeWalkPrompt } from "./native-walk.mjs";

test("browser entrypoint validates owners through a directory alias while non-file argv imports stay inert", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-browser-entry-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const alias = path.join(root, "adapter alias");
	fs.symlinkSync(fileURLToPath(new URL(".", import.meta.url)), alias, "dir");
	const result = spawnSync(
		process.execPath,
		[path.join(alias, "native-browser.mjs"), "invalid", root],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.equal(result.status, 1, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		ready: false,
		error: "Invalid browser owner",
	});
	const imported = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`process.argv[1] = "not-a-file"; await import(${JSON.stringify(new URL("./native-browser.mjs", import.meta.url).href)}); console.log("imported");`,
		],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(imported.stdout, "imported\n");
	assert.equal(imported.stderr, "");
});

test(
	"owned Chrome captures semantic clicks, stacks, failed API/query diagnostics and pause boundaries through handoff",
	{
		skip: process.env.CAP_UX_BROWSER_SMOKE !== "1",
		timeout: 30000,
	},
	async (t) => {
		const { openBrowser } = await import(
			process.env.CAP_UX_TEST_ENGINE_DIR
				? pathToFileURL(
						path.join(process.env.CAP_UX_TEST_ENGINE_DIR, "src/browser.mjs"),
					)
				: "../../../vendor/ux-walk/src/browser.mjs"
		);
		const { buildTimeline, renderTimeline, readActions } = await import(
			"../../../vendor/ux-walk/src/timeline.mjs"
		);
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "ux-walk-browser-smoke-"),
		);
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const server = http.createServer((request, response) => {
			if (request.url.startsWith("/disconnect")) {
				request.socket.destroy();
				return;
			}
			if (request.url.startsWith("/rest/v1/rpc/save")) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						code: "23514",
						message: "Invalid planning window",
						details: "Dates extend outside the draft",
						hint: "Review Generate dates",
						access_token: "SECRET_SENTINEL",
					}),
				);
				return;
			}
			if (request.url.startsWith("/api/down")) {
				response.writeHead(503);
				response.end("Unavailable");
				return;
			}
			response.writeHead(200, { "content-type": "text/html" });
			response.end(`<!doctype html><title>Synthetic walk page</title><button data-testid="save-window">Save window</button><script>
console.error("First-load synthetic error");
document.querySelector("button").onclick = () => {
 console.error("Synthetic console failure");
 fetch("/rest/v1/rpc/save?token=SECRET_SENTINEL", {method:"POST",body:JSON.stringify({password:"SECRET_SENTINEL"})});
 fetch("/api/down");
 fetch("/disconnect").catch(() => {});
 throw new Error("Synthetic uncaught failure");
};</script>`);
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		t.after(() => new Promise((resolve) => server.close(resolve)));
		const url = `http://127.0.0.1:${server.address().port}`;
		const evidence = new NativeBrowserEvidence(
			"synthetic-browser",
			path.join(root, "prepared"),
		);
		const windowEvents = new OwnedWindowEvents(evidence);
		const browser = await openBrowser({
			url,
			authFile: path.join(root, "auth.json"),
			windowSize: "960,720",
			trace: false,
			ignoreWrites: "$^",
			write: (event, page) => windowEvents.write(event, page),
			notesDir: () => evidence.notesDir(),
			canCapturePage: (page) => windowEvents.canCapturePage(page),
		});
		t.after(() => browser.close());
		const source = path.join(root, "source.cap");
		const directory = path.join(root, "walk");
		fs.mkdirSync(source);
		fs.mkdirSync(directory);
		fs.writeFileSync(
			path.join(source, "recording-meta.json"),
			JSON.stringify({ status: { status: "Complete" } }),
		);
		fs.writeFileSync(path.join(source, "source.mp4"), "synthetic media");
		const startedAtMs = Date.now();
		const journal = {
			schemaVersion: 1,
			state: "recording",
			startedAtMs,
			durationMs: null,
			sourceProject: source,
			request: {
				directory,
				topic: "Synthetic browser evidence",
				url,
				speakers: [],
			},
			events: [],
		};
		const file = path.join(directory, "native-walk.json");
		fs.writeFileSync(file, JSON.stringify(journal));
		evidence.windowId = "17";
		evidence.start(file, "17");
		const page = browser.context.pages()[0];
		await page.getByRole("button", { name: "Save window" }).click();
		const deadline = Date.now() + 8000;
		let captured = [];
		do {
			await new Promise((resolve) => setTimeout(resolve, 25));
			captured = fs
				.readFileSync(path.join(directory, "browser-evidence.jsonl"), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(JSON.parse);
			if (
				captured.some((event) => event.resBody?.includes("23514")) &&
				captured.some((event) => event.ev === "network" && event.failure) &&
				captured.some((event) => event.ev === "http" && event.status === 503) &&
				captured.some((event) => event.ev === "pageerror") &&
				captured.some((event) => event.ev === "click")
			)
				break;
		} while (Date.now() < deadline);
		assert.ok(
			captured.some(
				(event) => event.ev === "click" && event.el.testid === "save-window",
			),
		);
		assert.ok(
			captured.some(
				(event) =>
					event.ev === "pageerror" &&
					event.text.includes("Synthetic uncaught failure"),
			),
		);
		assert.ok(
			captured.some(
				(event) =>
					event.ev === "write" &&
					event.status === 400 &&
					event.resBody.includes("Review Generate dates"),
			),
		);
		assert.ok(
			captured.some((event) => event.ev === "http" && event.status === 503),
		);
		assert.ok(
			captured.some((event) => event.ev === "network" && event.failure),
		);
		const sameTab = browser.context.waitForEvent("page");
		await page.evaluate((url) => {
			window.open(url, "_blank");
		}, `${url}/same-tab`);
		const same = await sameTab;
		await same.waitForLoadState("load");
		assert.ok(
			await windowEvents.accepts(same),
			"tabs in the captured Chrome window stay observable",
		);
		await same.evaluate(() => console.error("SAME_WINDOW_TAB_SENTINEL"));
		const popupTab = browser.context.waitForEvent("page");
		await page.evaluate((url) => {
			window.open(url, "auth-popup", "popup=yes,width=500,height=400");
		}, `${url}/popup`);
		const popup = await popupTab;
		await popup.waitForLoadState("load");
		assert.equal(
			await windowEvents.accepts(popup),
			false,
			"another Chrome window is outside the capture target",
		);
		await popup.evaluate(() => console.error("SEPARATE_WINDOW_SENTINEL"));
		const refusal = await popup.evaluate(() =>
			window.__uxwNote({ op: "new", box: { x: 0, y: 0, w: 20, h: 20 } }).then(
				() => "unexpected success",
				(error) => error.message,
			),
		);
		assert.match(refusal, /outside the recorded browser window/);
		await windowEvents.flush();
		const noteId = await same.evaluate(async () => {
			const id = await window.__uxwNote({
				op: "new",
				box: { x: 0, y: 0, w: 20, h: 20 },
			});
			await window.__uxwNote({ op: "save", id, text: "Browser annotation" });
			return id;
		});
		const noteFiles = () =>
			fs
				.readdirSync(evidence.notesDir())
				.map((name) => [
					name,
					fs.readFileSync(path.join(evidence.notesDir(), name)).toString("hex"),
				]);
		const beforePauseFiles = noteFiles();
		const pausedAt = Date.now();
		evidence.anchor(file, pausedAt, pausedAt - startedAtMs, true);
		await page.evaluate(() => console.error("PAUSED_PRIVATE_SENTINEL"));
		for (const op of ["new", "save", "reshoot", "drop"]) {
			const pausedNote = await same.evaluate(
				({ op, id }) =>
					window
						.__uxwNote({
							op,
							id,
							edit: true,
							text: "PAUSED_EDIT_SENTINEL",
							box: { x: 10, y: 10, w: 40, h: 40 },
						})
						.then(
							() => "unexpected success",
							(error) => error.message,
						),
				{ op, id: noteId },
			);
			assert.match(pausedNote, /outside the recorded browser window/);
		}
		assert.deepEqual(noteFiles(), beforePauseFiles);
		await new Promise((resolve) => setTimeout(resolve, 40));
		const resumedAt = Date.now();
		evidence.anchor(file, resumedAt, pausedAt - startedAtMs, false);
		await page.evaluate(() => console.warn("Resumed synthetic warning"));
		await new Promise((resolve) => setTimeout(resolve, 40));
		await same.bringToFront();
		await same
			.getByRole("button", { name: "Save window" })
			.click({ modifiers: ["Alt", "Shift"] });
		await same.waitForFunction(() =>
			Number.isInteger(window.__uxwOpenNote?.()?.id),
		);
		await same.locator("uxw-overlay input").fill("Unsaved note before Stop");
		const stoppedAt = Date.now();
		journal.durationMs = stoppedAt - startedAtMs - (resumedAt - pausedAt);
		evidence.anchor(file, stoppedAt, journal.durationMs, true);
		await flushNativeNotes(browser, evidence, windowEvents, stoppedAt);
		await windowEvents.flush();
		evidence.finish(file);
		const stoppedNote = await same.evaluate(() =>
			window.__uxwNote({ op: "new", box: { x: 0, y: 0, w: 20, h: 20 } }).then(
				() => "unexpected success",
				(error) => error.message,
			),
		);
		assert.match(stoppedNote, /outside the recorded browser window/);
		journal.state = "complete";
		journal.events.push({
			kind: "note",
			text: "Investigate failed save",
			offsetMs: 1,
		});
		fs.writeFileSync(file, JSON.stringify(journal));
		assert.ok(projectBrowserEvidence(file, journal).events.length > 5);
		await finishNativeWalk(
			file,
			{ transcriber: "none", brief: false },
			{
				client: {
					export: async (_project, output) => {
						fs.writeFileSync(output, "synthetic export");
						return { durationS: journal.durationMs / 1000 };
					},
				},
				clip: async (_video, output) =>
					fs.writeFileSync(output, "synthetic chapter"),
				processChapter: async (chapterDir) => {
					const chapter = JSON.parse(
						fs.readFileSync(path.join(chapterDir, "chapter.json")),
					);
					const actions = readActions(
						path.join(directory, "actions.jsonl"),
						chapter.startMs,
						chapter.endMs,
					);
					const rows = buildTimeline({
						actions,
						startMs: chapter.startMs,
						cues: [],
						appOrigin: url,
						ignoreWrites: "$^",
						ignoreConsole: "$^",
					});
					for (const short of [true, false]) {
						fs.writeFileSync(
							path.join(
								chapterDir,
								short ? "timeline-short.md" : "timeline.md",
							),
							renderTimeline(rows, {
								title: "Synthetic",
								startMs: chapter.startMs,
								short,
							}).text,
						);
					}
					return {};
				},
				writeIndex: () => {},
			},
		);
		for (const artifact of [
			"actions.jsonl",
			"01-walkthrough/timeline.md",
			"report.html",
			"agent-prompt.txt",
		]) {
			const text = fs.readFileSync(path.join(directory, artifact), "utf8");
			assert.match(text, /23514/, artifact);
			assert.match(text, /Review Generate dates/, artifact);
			assert.equal(text.includes("SECRET_SENTINEL"), false, artifact);
			assert.equal(text.includes("PAUSED_PRIVATE_SENTINEL"), false, artifact);
			assert.equal(text.includes("PAUSED_EDIT_SENTINEL"), false, artifact);
			assert.equal(text.includes("SEPARATE_WINDOW_SENTINEL"), false, artifact);
		}
		assert.match(
			fs.readFileSync(path.join(directory, "actions.jsonl"), "utf8"),
			/SAME_WINDOW_TAB_SENTINEL/,
		);
		assert.match(
			fs.readFileSync(path.join(directory, "report.html"), "utf8"),
			/Unsaved note before Stop/,
		);
		assert.match(nativeWalkPrompt(file), /no server-side query trace/);
		assert.match(nativeWalkPrompt(file), /browser-preroll/);
	},
);
