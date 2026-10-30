import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createLinuxBundleConfig,
	RPM_DEPENDS,
	supportedLinuxBundles,
} from "./linux-bundle-config.mjs";

test("nightly builds retain DEB and AppImage without passing invalid hyphenated versions to RPM", () => {
	assert.deepEqual(supportedLinuxBundles("0.6.0"), ["deb", "rpm", "appimage"]);
	assert.deepEqual(supportedLinuxBundles("0.6.0-nightly.202608261700"), [
		"deb",
		"appimage",
	]);
	assert.deepEqual(supportedLinuxBundles("0.6.0-rc.1"), ["deb", "appimage"]);
});

test("all Linux formats map the exact native library sonames from the app directory", () => {
	const config = createLinuxBundleConfig([
		"libonnxruntime.so",
		"libavcodec.so.61",
		"libonnxruntime.so.1",
	]);

	for (const format of ["deb", "rpm", "appimage"]) {
		assert.equal(
			config.bundle.linux[format].files["/usr/lib/cap/libavcodec.so.61"],
			"../../target/native-deps/cap-deb-libs/libavcodec.so.61",
		);
		assert.equal(
			config.bundle.linux[format].files["/usr/lib/cap/libonnxruntime.so.1"],
			"../../target/native-deps/cap-deb-libs/libonnxruntime.so.1",
		);
	}
	assert.equal(
		config.bundle.linux.deb.files["/usr/lib/cap/package-format"],
		"../../packaging/linux/deb",
	);
});

test("AppImage includes the system-audio control tool without a webview media framework", () => {
	const { appimage, deb, rpm } = createLinuxBundleConfig([]).bundle.linux;
	assert.equal(appimage.files["/usr/bin/pactl"], "/usr/bin/pactl");
	assert.equal(appimage.bundleMediaFramework, false);
	assert.equal(
		appimage.files["/usr/lib/alsa-lib/libasound_module_pcm_pulse.so"],
		"../../target/native-deps/cap-appimage-libs/libasound_module_pcm_pulse.so",
	);
	assert.equal(
		appimage.files["/usr/lib/cap/alsa-pulse.conf"],
		"../../packaging/linux/alsa-pulse.conf",
	);
	for (const format of [deb, rpm]) {
		assert.equal(format.files["/usr/lib/cap/alsa-pulse.conf"], undefined);
	}
});

test("library mappings are deterministic", () => {
	const first = createLinuxBundleConfig(["libz.so.1", "liba.so.2"]);
	const second = createLinuxBundleConfig([
		"liba.so.2",
		"libz.so.1",
		"liba.so.2",
	]);
	assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("Debian audio dependencies retain existing requirements without duplicates", () => {
	const dependencies = ["libxkbcommon0", "libasound2-plugins"];
	const config = createLinuxBundleConfig([], dependencies);
	assert.deepEqual(config.bundle.linux.deb.depends, dependencies);
	assert.notEqual(config.bundle.linux.deb.depends, dependencies);
	assert.deepEqual(
		createLinuxBundleConfig([], ["libxkbcommon0"]).bundle.linux.deb.depends,
		["libxkbcommon0", "libasound2-plugins"],
	);
});

test("package dependencies carry no webview packages", () => {
	const { deb, rpm } = createLinuxBundleConfig([], ["libxkbcommon0"]).bundle
		.linux;
	for (const depends of [deb.depends, rpm.depends]) {
		assert.ok(
			!depends.some((dependency) => /webkit|gtk|appindicator/.test(dependency)),
		);
	}
	assert.deepEqual(rpm.depends, RPM_DEPENDS);
	assert.notEqual(rpm.depends, RPM_DEPENDS);
});
