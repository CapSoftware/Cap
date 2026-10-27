import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	accentColorName,
	accentNameFromPartialPlist,
	actoolArguments,
	iconComposerName,
	iconNameFromPartialPlist,
} from "./build-macos-icon.mjs";

test("actool compiles the Icon Composer file for macOS 12.3 and later", () => {
	const args = actoolArguments({
		source: "/tmp/cap-solarium.icon",
		output: "/tmp/out",
		partialPlist: "/tmp/out/partial.plist",
	});
	assert.equal(args[0], "/tmp/cap-solarium.icon");
	assert.deepEqual(
		args.slice(args.indexOf("--app-icon"), args.indexOf("--app-icon") + 2),
		["--app-icon", iconComposerName],
	);
	assert.equal(args[args.indexOf("--minimum-deployment-target") + 1], "12.3");
	assert.equal(args[args.indexOf("--platform") + 1], "macosx");
});

test("actool also compiles the Cap asset catalog for the accent color", () => {
	const args = actoolArguments({
		source: "/tmp/cap-solarium.icon",
		catalog: "/tmp/Cap.xcassets",
		output: "/tmp/out",
		partialPlist: "/tmp/out/partial.plist",
	});
	assert.equal(args[1], "/tmp/Cap.xcassets");
	assert.equal(args[args.indexOf("--accent-color") + 1], accentColorName);
});

test("the accent name comes from the partial plist when actool writes one", () => {
	const plist = readFileSync(
		new URL("./fixtures/actool-partial.plist", import.meta.url),
		"utf8",
	);
	assert.equal(accentNameFromPartialPlist(plist), undefined);
	assert.equal(
		accentNameFromPartialPlist(
			"<key>NSAccentColorName</key>\n<string>AccentColor</string>",
		),
		"AccentColor",
	);
});

test("the icon name comes from the partial plist actool writes", () => {
	const plist = readFileSync(
		new URL("./fixtures/actool-partial.plist", import.meta.url),
		"utf8",
	);
	assert.equal(iconNameFromPartialPlist(plist), "cap-solarium");
	assert.throws(() => iconNameFromPartialPlist("<plist/>"), /CFBundleIconName/);
});
