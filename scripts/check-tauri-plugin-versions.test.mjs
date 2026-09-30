import assert from "node:assert/strict";
import test from "node:test";
import {
	compareTauriRuntimeVersions,
	parseDesktopTauriDependencies,
	parseDesktopTauriVersions,
} from "./check-tauri-plugin-versions.js";

function bunLock(cli, api = "2.8.0") {
	return JSON.stringify({
		lockfileVersion: 2,
		workspaces: {
			"apps/desktop": {
				name: "@cap/desktop",
				dependencies: { "@tauri-apps/api": `^${api}` },
				devDependencies: { "@tauri-apps/cli": `^${cli}` },
			},
			"apps/legacy": {
				name: "legacy",
				devDependencies: { "@tauri-apps/cli": "1.6.3" },
			},
		},
		packages: {
			"@tauri-apps/api": [`@tauri-apps/api@${api}`, "", {}],
			"@tauri-apps/cli": ["@tauri-apps/cli@1.6.3", "", {}],
			"@cap/desktop/@tauri-apps/cli": [`@tauri-apps/cli@${cli}`, "", {}],
		},
	});
}

function cargoLock(version = "2.8.5") {
	return `[[package]]
name = "tauri"
version = "${version}"
`;
}

test("matching Tauri runtime versions allow independent patch releases", () => {
	const versions = parseDesktopTauriVersions(bunLock("2.8.4"), cargoLock());
	assert.deepEqual(versions, { api: "2.8.0", cli: "2.8.4", rust: "2.8.5" });
	assert.ok(
		compareTauriRuntimeVersions(versions).every((entry) => entry.matching),
	);
});

test("newer CLI minors cannot silently mismatch the locked Rust runtime", () => {
	const versions = parseDesktopTauriVersions(bunLock("2.11.4"), cargoLock());
	const results = compareTauriRuntimeVersions(versions);
	assert.equal(
		results.find((entry) => entry.jsName.endsWith("api"))?.matching,
		true,
	);
	assert.equal(
		results.find((entry) => entry.jsName.endsWith("cli"))?.matching,
		false,
	);
});

test("a mismatched JavaScript API minor is rejected independently", () => {
	const versions = parseDesktopTauriVersions(
		bunLock("2.8.4", "2.9.0"),
		cargoLock(),
	);
	const result = compareTauriRuntimeVersions(versions).find((entry) =>
		entry.jsName.endsWith("api"),
	);
	assert.equal(result?.matching, false);
});

test("the desktop importer is isolated from legacy Tauri applications", () => {
	const versions = parseDesktopTauriVersions(bunLock("2.8.4"), cargoLock());
	assert.equal(versions.cli, "2.8.4");
});

test("missing desktop runtime dependencies fail closed", () => {
	assert.throws(
		() =>
			parseDesktopTauriVersions(
				bunLock("2.8.4").replaceAll("@tauri-apps/api", "missing-api"),
				cargoLock(),
			),
		/Missing @tauri-apps\/api/,
	);
	assert.throws(
		() => parseDesktopTauriVersions(bunLock("2.8.4"), ""),
		/Missing "tauri" package/,
	);
});

test("Bun JSONC supports comments and trailing commas", () => {
	const lock = bunLock("2.8.4")
		.replace('{"lockfileVersion":2,', '{/* lock */ "lockfileVersion":2,')
		.replace(/}$/, ",}");
	assert.equal(parseDesktopTauriVersions(lock, cargoLock()).cli, "2.8.4");
});

test("plugin checks use resolved versions and the desktop workspace override", () => {
	const lock = JSON.parse(bunLock("2.8.4"));
	lock.workspaces["apps/desktop"].dependencies["@tauri-apps/plugin-store"] =
		"^2.4.0";
	lock.packages["@tauri-apps/plugin-store"] = [
		"@tauri-apps/plugin-store@2.5.0",
	];
	lock.packages["@cap/desktop/@tauri-apps/plugin-store"] = [
		"@tauri-apps/plugin-store@2.4.3",
	];
	assert.equal(
		parseDesktopTauriDependencies(JSON.stringify(lock))[
			"@tauri-apps/plugin-store"
		],
		"2.4.3",
	);
});

test("malformed, unsupported and incomplete lockfiles fail closed", () => {
	assert.throws(() => parseDesktopTauriDependencies("{"), /Invalid bun.lock/);
	assert.throws(
		() => parseDesktopTauriDependencies('{"lockfileVersion":3}'),
		/Unsupported/,
	);
	const lock = JSON.parse(bunLock("2.8.4"));
	delete lock.packages["@tauri-apps/api"];
	assert.throws(
		() => parseDesktopTauriDependencies(JSON.stringify(lock)),
		/Missing resolved @tauri-apps\/api/,
	);
});
