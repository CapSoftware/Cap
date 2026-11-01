import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	bundledNodeMajor,
	isSystemLibrary,
	linkedLibraries,
	verifyBundledNode,
} from "./bundle-ux-walk.mjs";

const macOnly = { skip: process.platform !== "darwin" };

test("linked libraries cover every architecture of a universal binary", () => {
	const output = [
		"/tmp/Cap UX.app/node (architecture x86_64):",
		"\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)",
		"/tmp/Cap UX.app/node (architecture arm64):",
		"\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)",
		"\t/System/Library/Frameworks/Core Foundation.framework/CoreFoundation (compatibility version 150.0.0, current version 2000.0.0, weak)",
		"",
	].join("\n");
	assert.deepEqual(linkedLibraries(output), [
		"/usr/lib/libSystem.B.dylib",
		"/System/Library/Frameworks/Core Foundation.framework/CoreFoundation",
	]);
});

test("a Homebrew launcher fails the system library check", () => {
	const libraries = linkedLibraries(
		[
			"/opt/homebrew/opt/node@22/bin/node:",
			"\t@rpath/libnode.127.dylib (compatibility version 0.0.0, current version 0.0.0)",
			"\t/usr/lib/libz.1.dylib (compatibility version 1.0.0, current version 1.2.12)",
			"\t/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 1.0.0, current version 1.0.0)",
		].join("\n"),
	);
	assert.deepEqual(
		libraries.filter((library) => !isSystemLibrary(library)),
		["@rpath/libnode.127.dylib", "/opt/homebrew/opt/libuv/lib/libuv.1.dylib"],
	);
});

test("only /usr/lib and /System count as system libraries", () => {
	for (const library of [
		"/usr/lib/libc++.1.dylib",
		"/System/Library/Frameworks/Security.framework/Versions/A/Security",
	]) {
		assert.equal(isSystemLibrary(library), true, library);
	}
	for (const library of [
		"/usr/local/lib/libuv.1.dylib",
		"/usr/libexec/libfake.dylib",
		"/usr/lib/../local/lib/libuv.1.dylib",
		"/Systematic/libfake.dylib",
		"@loader_path/../lib/libnode.dylib",
		"@executable_path/libnode.dylib",
		"libnode.dylib",
	]) {
		assert.equal(isSystemLibrary(library), false, library);
	}
});

test("a file with no readable libraries is refused", macOnly, async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-ux-node-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const script = path.join(directory, "node");
	await fs.writeFile(script, "#!/bin/sh\necho v22.0.0\n", { mode: 0o755 });
	assert.throws(
		() => verifyBundledNode(script),
		/Could not read the libraries/,
	);
});

test(
	"a system binary with the wrong version output is refused",
	macOnly,
	() => {
		assert.throws(
			() => verifyBundledNode("/usr/bin/true"),
			/expected version 22/,
		);
	},
);

test("a binary that cannot run is refused", macOnly, () => {
	assert.throws(() => verifyBundledNode("/usr/bin/false"), /could not run/);
});

test("the bundled major matches the CI Node", () => {
	const workflow = readFileSync(
		new URL("../.github/workflows/ux-walk-check.yml", import.meta.url),
		"utf8",
	);
	const versions = [...workflow.matchAll(/node-version: '(\d+)'/g)].map(
		(match) => Number(match[1]),
	);
	assert.ok(versions.length > 0);
	assert.ok(versions.every((version) => version === bundledNodeMajor));
});
