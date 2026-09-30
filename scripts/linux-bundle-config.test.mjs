import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createLinuxBundleConfig,
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

test("all Linux formats retain the exact native library sonames and shared icons", () => {
	const icon =
		"/usr/share/icons/hicolor/scalable/status/so.cap.desktop-tray-studio-symbolic.svg";
	const config = createLinuxBundleConfig(
		["libonnxruntime.so", "libavcodec.so.61", "libonnxruntime.so.1"],
		{ [icon]: "icons/linux/so.cap.desktop-tray-studio-symbolic.svg" },
	);

	for (const format of ["deb", "rpm", "appimage"]) {
		assert.equal(
			config.bundle.linux[format].files["/usr/lib/cap/libavcodec.so.61"],
			"../../../target/native-deps/cap-deb-libs/libavcodec.so.61",
		);
		assert.equal(
			config.bundle.linux[format].files["/usr/lib/cap/libonnxruntime.so.1"],
			"../../../target/native-deps/cap-deb-libs/libonnxruntime.so.1",
		);
		assert.equal(
			config.bundle.linux[format].files[icon],
			"icons/linux/so.cap.desktop-tray-studio-symbolic.svg",
		);
	}
});

test("AppImage includes the system-audio control tool and webview media framework", () => {
	const { appimage, deb, rpm } = createLinuxBundleConfig([]).bundle.linux;
	assert.equal(appimage.files["/usr/bin/pactl"], "/usr/bin/pactl");
	assert.equal(appimage.bundleMediaFramework, true);
	assert.equal(
		appimage.files["/usr/lib/alsa-lib/libasound_module_pcm_pulse.so"],
		"../../../target/native-deps/cap-appimage-libs/libasound_module_pcm_pulse.so",
	);
	assert.equal(
		appimage.files["/usr/lib/cap/alsa-pulse.conf"],
		"../../../packaging/linux/alsa-pulse.conf",
	);
	for (const format of [deb, rpm]) {
		assert.equal(format.files["/usr/lib/cap/alsa-pulse.conf"], undefined);
	}
});

test("library mappings are deterministic and preserve the input mappings", () => {
	const files = { "/usr/share/cap/example": "example" };
	const first = createLinuxBundleConfig(["libz.so.1", "liba.so.2"], files);
	const second = createLinuxBundleConfig(
		["liba.so.2", "libz.so.1", "liba.so.2"],
		files,
	);
	assert.equal(JSON.stringify(first), JSON.stringify(second));
	assert.deepEqual(files, { "/usr/share/cap/example": "example" });
});

test("Debian audio dependencies retain existing requirements without duplicates", () => {
	const dependencies = ["libgtk-3-0", "libasound2-plugins"];
	const config = createLinuxBundleConfig([], {}, dependencies);
	assert.deepEqual(config.bundle.linux.deb.depends, dependencies);
	assert.notEqual(config.bundle.linux.deb.depends, dependencies);
	assert.deepEqual(
		createLinuxBundleConfig([], {}, ["libgtk-3-0"]).bundle.linux.deb.depends,
		["libgtk-3-0", "libasound2-plugins"],
	);
});
