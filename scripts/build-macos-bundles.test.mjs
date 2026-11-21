import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	extensions,
	plistVersion,
	signingArguments,
	swiftArchitecture,
} from "./build-macos-bundles.mjs";

const readPlist = (relative) =>
	readFileSync(
		new URL(`../apps/macos-bundles/${relative}`, import.meta.url),
		"utf8",
	);

test("each Quick Look extension is its own bundle with its own extension point", () => {
	const points = {
		CapQuickLookThumbnail: "com.apple.quicklook.thumbnail",
		CapQuickLookPreview: "com.apple.quicklook.preview",
	};
	for (const extension of extensions) {
		const plist = readPlist(`Bundles/${extension.product}/Info.plist`);
		assert.match(plist, new RegExp(`<string>${extension.bundleId}</string>`));
		assert.match(
			plist,
			new RegExp(`<string>${points[extension.product]}</string>`),
		);
		assert.match(plist, /<string>so\.cap\.desktop\.project<\/string>/);
		assert.match(plist, /<string>XPC!<\/string>/);
	}
});

test("each principal class is the @objc name its provider exports", () => {
	for (const extension of extensions) {
		const plist = readPlist(`Bundles/${extension.product}/Info.plist`);
		const source = readPlist(
			`Sources/${extension.product}/${extension.product.replace("CapQuickLook", "")}Provider.swift`,
		);
		const principal =
			/<key>NSExtensionPrincipalClass<\/key>\s*<string>([^<]+)<\/string>/.exec(
				plist,
			)[1];
		const objc = /@objc\(([A-Za-z]+)\)/.exec(source)[1];
		assert.equal(principal, objc);
	}
});

test("signing uses hardened runtime, a timestamp and the sandbox entitlements", () => {
	assert.deepEqual(
		signingArguments({
			identity: "Developer ID Application: Cap",
			keychain: "/tmp/build.keychain",
			entitlements: "/repo/Sandbox.entitlements",
			bundle: "/tmp/Thumb.appex",
		}),
		[
			"--force",
			"--timestamp",
			"--options",
			"runtime",
			"--entitlements",
			"/repo/Sandbox.entitlements",
			"--sign",
			"Developer ID Application: Cap",
			"--keychain",
			"/tmp/build.keychain",
			"/tmp/Thumb.appex",
		],
	);
});

test("targets map to Swift architectures and unknown targets fail", () => {
	assert.equal(swiftArchitecture("aarch64-apple-darwin"), "arm64");
	assert.equal(swiftArchitecture("x86_64-apple-darwin"), "x86_64");
	assert.throws(
		() => swiftArchitecture("x86_64-pc-windows-msvc"),
		/Unsupported/,
	);
});

test("the bundle version comes from the GPUI crate", () => {
	assert.equal(
		plistVersion('[package]\nname = "cap-gpui"\nversion = "0.6.1"\n'),
		"0.6.1",
	);
	assert.throws(
		() => plistVersion('[package]\nname = "x"\n'),
		/package.version/,
	);
});
