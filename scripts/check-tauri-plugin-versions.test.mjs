import assert from "node:assert/strict";
import test from "node:test";
import {
	compareTauriRuntimeVersions,
	parseDesktopTauriVersions,
} from "./check-tauri-plugin-versions.js";

function pnpmLock(cli, api = "2.8.0") {
	return `importers:

  apps/desktop:
    dependencies:
      '@tauri-apps/api':
        specifier: ${api}
        version: ${api}
    devDependencies:
      '@tauri-apps/cli':
        specifier: ${cli}
        version: ${cli}

  apps/legacy:
    devDependencies:
      '@tauri-apps/cli':
        specifier: 1.6.3
        version: 1.6.3
`;
}

function cargoLock(version = "2.8.5") {
	return `[[package]]
name = "tauri"
version = "${version}"
`;
}

test("matching Tauri runtime versions allow independent patch releases", () => {
	const versions = parseDesktopTauriVersions(pnpmLock("2.8.4"), cargoLock());
	assert.deepEqual(versions, { api: "2.8.0", cli: "2.8.4", rust: "2.8.5" });
	assert.ok(
		compareTauriRuntimeVersions(versions).every((entry) => entry.matching),
	);
});

test("newer CLI minors cannot silently mismatch the locked Rust runtime", () => {
	const versions = parseDesktopTauriVersions(pnpmLock("2.11.4"), cargoLock());
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
		pnpmLock("2.8.4", "2.9.0"),
		cargoLock(),
	);
	const result = compareTauriRuntimeVersions(versions).find((entry) =>
		entry.jsName.endsWith("api"),
	);
	assert.equal(result?.matching, false);
});

test("the desktop importer is isolated from legacy Tauri applications", () => {
	const versions = parseDesktopTauriVersions(pnpmLock("2.8.4"), cargoLock());
	assert.equal(versions.cli, "2.8.4");
});

test("missing desktop runtime dependencies fail closed", () => {
	assert.throws(
		() =>
			parseDesktopTauriVersions("importers:\n  apps/desktop:\n", cargoLock()),
		/Missing @tauri-apps\/api/,
	);
	assert.throws(
		() => parseDesktopTauriVersions(pnpmLock("2.8.4"), ""),
		/Missing "tauri" package/,
	);
});
