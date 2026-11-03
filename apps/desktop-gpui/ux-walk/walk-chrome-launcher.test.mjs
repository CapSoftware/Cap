import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launchWalkChrome } from "./native-browser.mjs";

function scratch(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-launcher-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

function fakeType(failFirst = false) {
	const calls = [];
	return {
		calls,
		async launch(options) {
			calls.push(options);
			if (failFirst && calls.length === 1) throw new Error("launcher exited");
			return { launched: calls.length };
		},
	};
}

const base = { channel: "chrome", headless: false, args: ["--a"] };

test("Chrome starts through the launcher, which is told the real Chrome", async (t) => {
	const launcher = path.join(scratch(t), "launcher");
	fs.writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o755 });
	const type = fakeType();
	const logs = [];
	const browser = await launchWalkChrome(type, base, {
		launcher,
		chrome: "/real/chrome",
		log: (line) => logs.push(line),
	});
	assert.deepEqual(browser, { launched: 1 });
	assert.equal(type.calls.length, 1);
	assert.equal(type.calls[0].executablePath, launcher);
	assert.equal(type.calls[0].env.UXW_CHROME_EXECUTABLE, "/real/chrome");
	assert.deepEqual(type.calls[0].args, ["--a"]);
	assert.deepEqual(logs, []);
});

test("a missing launcher logs a line and starts Chrome normally", async (t) => {
	const type = fakeType();
	const logs = [];
	await launchWalkChrome(type, base, {
		launcher: path.join(scratch(t), "absent"),
		log: (line) => logs.push(line),
	});
	assert.deepEqual(type.calls, [base]);
	assert.equal(logs.length, 1);
	assert.match(logs[0], /missing; starting Chrome normally/);
});

test("a launcher that fails logs a line and starts Chrome normally", async (t) => {
	const launcher = path.join(scratch(t), "launcher");
	fs.writeFileSync(launcher, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	const type = fakeType(true);
	const logs = [];
	const browser = await launchWalkChrome(type, base, {
		launcher,
		log: (line) => logs.push(line),
	});
	assert.deepEqual(browser, { launched: 2 });
	assert.deepEqual(type.calls[1], base);
	assert.equal(logs.length, 1);
	assert.match(logs[0], /failed \(launcher exited\); starting Chrome normally/);
});

test("a normal start that also fails reports its own error", async (t) => {
	const type = {
		launch: async () => {
			throw new Error("Chrome is not installed");
		},
	};
	await assert.rejects(
		launchWalkChrome(type, base, {
			launcher: path.join(scratch(t), "absent"),
			log: () => {},
		}),
		/Chrome is not installed/,
	);
});

test(
	"the built launcher keeps its pid, passes arguments and open pipes, and reports a bad target",
	{ skip: process.platform !== "darwin" },
	(t) => {
		const root = scratch(t);
		const launcher = path.join(root, "launcher");
		execFileSync("cc", [
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-o",
			launcher,
			fileURLToPath(new URL("./walk-chrome-launcher.c", import.meta.url)),
		]);
		const target = path.join(root, "target.sh");
		fs.writeFileSync(
			target,
			'#!/bin/sh\necho "pid=$$ args=$* env=$UXW_CHROME_EXECUTABLE"\necho piped >&3\n',
			{ mode: 0o755 },
		);
		const run = (env, args = []) =>
			spawnSync(launcher, args, {
				encoding: "utf8",
				env: { PATH: process.env.PATH, ...env },
				stdio: ["ignore", "pipe", "pipe", "pipe"],
			});
		const ran = run({ UXW_CHROME_EXECUTABLE: target }, ["--a", "b c"]);
		assert.equal(ran.status, 0, ran.stderr);
		assert.equal(ran.stdout, `pid=${ran.pid} args=--a b c env=\n`);
		assert.equal(ran.output[3], "piped\n");
		assert.equal(ran.stderr, "");

		const bad = run({ UXW_CHROME_EXECUTABLE: path.join(root, "absent") });
		assert.equal(bad.status, 126);
		assert.match(bad.stderr, /could not start Chrome/);
		assert.equal(run({}).status, 127);
	},
);
