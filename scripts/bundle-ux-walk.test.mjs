import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	bundledNodeMajor,
	entitlements,
	isSystemLibrary,
	linkedLibraries,
	nestedCode,
	signApp,
	verifyBundledNode,
} from "./bundle-ux-walk.mjs";

const macOnly = { skip: process.platform !== "darwin" };

test("linked libraries cover every architecture of a universal binary", () => {
	const output = [
		"/tmp/App.app/node (architecture x86_64):",
		"\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)",
		"/tmp/App.app/node (architecture arm64):",
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
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ux-walk-node-"));
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

const plist = (values) =>
	`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${Object.entries(
		values,
	)
		.map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
		.join("")}</dict></plist>\n`;

const codesign = (...args) =>
	execFileSync("codesign", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

async function unsignedBinary(destination) {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.copyFile("/usr/bin/true", destination);
	codesign("--remove-signature", destination);
}

async function appWithUnsignedFramework(directory) {
	const app = path.join(directory, "Test.app");
	const contents = path.join(app, "Contents");
	await fs.mkdir(contents, { recursive: true });
	await fs.writeFile(
		path.join(contents, "Info.plist"),
		plist({
			CFBundleExecutable: "Test",
			CFBundleIdentifier: "test.bundle-ux-walk",
			CFBundlePackageType: "APPL",
		}),
	);
	await unsignedBinary(path.join(contents, "MacOS", "Test"));
	const framework = path.join(contents, "Frameworks", "Fixture.framework");
	const version = path.join(framework, "Versions", "A");
	await fs.mkdir(path.join(version, "Resources"), { recursive: true });
	await fs.writeFile(
		path.join(version, "Resources", "Info.plist"),
		plist({
			CFBundleExecutable: "Fixture",
			CFBundleIdentifier: "test.fixture",
			CFBundlePackageType: "FMWK",
		}),
	);
	await unsignedBinary(path.join(version, "Fixture"));
	await unsignedBinary(path.join(version, "Libraries", "libfixture.dylib"));
	await fs.symlink("A", path.join(framework, "Versions", "Current"));
	for (const name of ["Fixture", "Resources", "Libraries"]) {
		await fs.symlink(
			path.join("Versions", "Current", name),
			path.join(framework, name),
		);
	}
	const node = path.join(contents, "Resources", "ux-walk", "bin", "node");
	await unsignedBinary(node);
	await fs.writeFile(
		path.join(contents, "Resources", "ux-walk", "package.json"),
		"{}\n",
	);
	const nodeEntitlements = path.join(directory, "node.plist");
	await fs.writeFile(
		nodeEntitlements,
		'<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>com.apple.security.cs.disable-executable-page-protection</key><true/></dict></plist>\n',
	);
	codesign("--sign", "-", "--entitlements", nodeEntitlements, node);
	return { app, contents, framework, version, node };
}

test(
	"nested code is listed inside out, without symlinks or the main executable",
	macOnly,
	async (t) => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ux-walk-sign-"));
		t.after(() => fs.rm(directory, { recursive: true, force: true }));
		const { app, framework, version, node } =
			await appWithUnsignedFramework(directory);
		assert.deepEqual(await nestedCode(app, "Test"), [
			path.join(version, "Fixture"),
			path.join(version, "Libraries", "libfixture.dylib"),
			framework,
			node,
		]);
	},
);

test(
	"an app with an unsigned framework signs and passes the strict verify",
	macOnly,
	async (t) => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ux-walk-sign-"));
		t.after(() => fs.rm(directory, { recursive: true, force: true }));
		const { app, node } = await appWithUnsignedFramework(directory);
		assert.throws(() => codesign("--verify", "--deep", "--strict", app));
		await signApp(app, "-");
		codesign("--verify", "--deep", "--strict", app);
		const appEntitlements = codesign("-d", "--entitlements", "-", "--xml", app);
		for (const key of [
			...readFileSync(entitlements, "utf8").matchAll(/<key>([^<]+)<\/key>/g),
		].map((match) => match[1])) {
			assert.ok(appEntitlements.includes(key), key);
		}
		assert.match(
			codesign("-d", "--entitlements", "-", "--xml", node),
			/com\.apple\.security\.cs\.disable-executable-page-protection/,
		);
	},
);
