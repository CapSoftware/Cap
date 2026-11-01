import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
	brand,
	expand,
	infoPlistEdits,
	minimumMacos,
	tauriOverlay,
} from "./fork-brand.mjs";

const read = (relative) =>
	readFileSync(new URL(relative, import.meta.url), "utf8");
const upstream = JSON.parse(read("../apps/desktop-gpui/tauri.conf.json"));

test("the bundle overlay carries the identity in brand.json", () => {
	const overlay = tauriOverlay();
	assert.equal(overlay.productName, brand.display_name);
	assert.equal(overlay.identifier, brand.bundle_id);
	assert.deepEqual(overlay.plugins["deep-link"].desktop.schemes, [
		brand.url_scheme,
	]);
	assert.equal(overlay.bundle.createUpdaterArtifacts, false);
	assert.equal(overlay.bundle.longDescription, expand(brand.long_description));
	assert.deepEqual(overlay.bundle.icon, brand.icon);
	assert.equal(overlay.bundle.macOS.minimumSystemVersion, minimumMacos);
	for (const icon of brand.icon) {
		assert.ok(
			existsSync(new URL(`../apps/desktop-gpui/${icon}`, import.meta.url)),
		);
	}
});

test("the fork and original Cap can be installed side by side", () => {
	const overlay = tauriOverlay();
	assert.notEqual(overlay.productName, upstream.productName);
	assert.notEqual(overlay.identifier, upstream.identifier);
	assert.notDeepEqual(
		overlay.plugins["deep-link"],
		upstream.plugins["deep-link"],
	);
});

test("a rename keeps everything an existing install depends on", () => {
	assert.equal(brand.bundle_id, "com.cantrell.cap-ux");
	assert.equal(brand.url_scheme, "cap-ux");
	assert.ok(!brand.former_names.includes(brand.display_name));
	assert.ok(!brand.former_cli_names.includes(brand.cli_name));
	assert.ok(!brand.former_skill_names.includes(brand.skill_name));
});

test("the built app's plist carries the name and usage strings in brand.json", () => {
	const value = (edits, key) =>
		edits.find((edit) => edit[0] === "-replace" && edit[1] === key)?.[3];
	const edits = infoPlistEdits({
		CFBundleDocumentTypes: [{}],
		CFBundleLocalizations: ["en"],
	});
	assert.equal(value(edits, "CFBundleName"), brand.display_name);
	assert.equal(value(edits, "CFBundleDisplayName"), brand.display_name);
	assert.equal(
		value(edits, "CFBundleDocumentTypes.0.CFBundleTypeName"),
		expand(brand.macos.document_type_name),
	);
	assert.equal(
		value(edits, "NSCameraUsageDescription"),
		expand(brand.macos.camera_usage),
	);
	assert.equal(
		value(edits, "NSMicrophoneUsageDescription"),
		expand(brand.macos.microphone_usage),
	);
	assert.equal(
		value(edits, "NSScreenCaptureUsageDescription"),
		expand(brand.macos.screen_capture_usage),
	);
	assert.ok(
		edits.some(
			(edit) => edit[0] === "-remove" && edit[1] === "CFBundleLocalizations",
		),
	);
});

test("an isolated preview with no document types still brands", () => {
	const edits = infoPlistEdits({ CFBundleDocumentTypes: [] });
	assert.ok(!edits.some((edit) => edit[1].startsWith("CFBundleDocumentTypes")));
	assert.ok(!edits.some((edit) => edit[0] === "-remove"));
});
