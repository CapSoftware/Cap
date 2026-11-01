import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { brandLeaks } from "./fork-brand.mjs";
import {
	logoFullSvg,
	logoMarkSvg,
	masterParts,
	masterPath,
} from "./fork-brand-assets.mjs";

const desktop = new URL("../apps/desktop-gpui/", import.meta.url);
const repository = new URL("../", import.meta.url);
const read = (relative) => readFileSync(new URL(relative, desktop));
const text = (relative) => read(relative).toString("utf8");

const protectedCopies = [
	["assets/dock-icon.png", "assets/branding/dock-icon.png"],
];

const references = [
	["src/main_window.rs", '"icons/logo-full.svg"'],
	["src/main_window.rs", '"icons/logo-full-dark.svg"'],
	["src/screenshot_editor.rs", '"icons/logo-mark.svg"'],
	["src/main.rs", '"../assets/dock-icon.png"'],
	["src/permission_guide.rs", '"../assets/dock-icon.png"'],
];

const overlaidArt = [
	"icons/logo-full.svg",
	"icons/logo-full-dark.svg",
	"icons/logo-mark.svg",
];

const protectedByAttributes = [["assets/.gitattributes", ["dock-icon.png"]]];

test("upstream asset paths carry the fork art", () => {
	for (const [upstream, master] of protectedCopies) {
		assert.ok(
			read(upstream).equals(read(master)),
			`apps/desktop-gpui/${upstream} no longer matches apps/desktop-gpui/${master}. ` +
				`Re-copy the master over it (an upstream merge brought back Cap art), ` +
				`or run node scripts/fork-brand-assets.mjs if the fork art changed on purpose.`,
		);
	}
});

test("the code still draws the protected asset paths", () => {
	for (const [source, path] of references) {
		assert.ok(
			text(source).includes(path),
			`apps/desktop-gpui/${source} stopped naming ${path}. Upstream moved or ` +
				`renamed this asset: put the fork master at the new path, add it to the ` +
				`overlay in src/ux_walk/assets.rs or the nested .gitattributes, and ` +
				`update this guard.`,
		);
	}
});

test("fork logos win over upstream's at the paths the code draws", () => {
	const overlay = text("src/ux_walk/assets.rs");
	for (const path of overlaidArt) {
		assert.ok(overlay.includes(`"${path}"`), `the overlay lost ${path}`);
	}
	assert.match(
		text("src/assets.rs"),
		/crate::ux_walk::assets::ALL\s*\.iter\(\)\s*\.chain\(FONTS/,
		"the overlay must come first: Assets::load returns the first match",
	);
});

test("protected asset paths keep the fork side on upstream merges", () => {
	for (const [file, paths] of protectedByAttributes) {
		const lines = text(file).split("\n");
		for (const path of paths) {
			assert.ok(
				lines.includes(`${path} merge=ours`),
				`apps/desktop-gpui/${file} must keep "${path} merge=ours".`,
			);
		}
	}
});

test("derived logos are what the master generates", () => {
	const parts = masterParts(readFileSync(masterPath, "utf8"));
	for (const [file, svg] of [
		["assets/branding/logo-mark.svg", logoMarkSvg(parts)],
		["assets/branding/logo-full.svg", logoFullSvg(parts, "#12161F")],
		["assets/branding/logo-full-dark.svg", logoFullSvg(parts, "#FFFFFF")],
	]) {
		assert.equal(
			text(file),
			svg,
			`${file} is stale: run node scripts/fork-brand-assets.mjs`,
		);
	}
});

test("every generated image exists at its size", () => {
	const size = (file) => read(file).readUInt32BE(16);
	for (const [file, pixels] of [
		["assets/branding/app-icon.png", 1024],
		["assets/branding/dock-icon.png", 512],
		["assets/branding/app/32x32.png", 32],
		["assets/branding/app/128x128.png", 128],
		["assets/branding/app/128x128@2x.png", 256],
		["assets/tray/tray-default-icon-ux-walk.png", 88],
	]) {
		assert.equal(size(file), pixels, file);
	}
	assert.equal(
		read("assets/branding/app/icon.icns").toString("latin1", 0, 4),
		"icns",
	);
	assert.equal(read("assets/branding/app/icon.ico").readUInt16LE(2), 1);
	assert.ok(
		readFileSync(new URL("apps/cloud/public/icon.png", repository)).equals(
			read("assets/branding/dock-icon.png"),
		),
		"the cloud viewer's icon is stale: run node scripts/fork-brand-assets.mjs",
	);
});

test("no hard-coded fork name outside the door", () => {
	const files = execFileSync("git", ["ls-files", "-z"], {
		cwd: repository,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
		.split("\0")
		.filter(Boolean);
	const leaks = [];
	for (const file of files) {
		const url = new URL(file, repository);
		if (!existsSync(url)) continue;
		const contents = readFileSync(url);
		if (contents.includes(0)) continue;
		leaks.push(...brandLeaks(file, contents.toString("utf8")));
	}
	assert.deepEqual(
		leaks,
		[],
		"Use fork_brand (Rust), scripts/fork-brand.mjs (scripts) or brand.json (the " +
			"cloud), neutral wording, or add a stable identifier to " +
			"crates/fork-brand/kept-names.json with the reason it cannot change.",
	);
});

test("the name guard catches what it is meant to catch", () => {
	const leak = (file, line) => brandLeaks(file, line).length > 0;
	assert.ok(leak("apps/desktop-gpui/src/main.rs", '"Worm Settings"'));
	assert.ok(leak("apps/desktop-gpui/src/main.rs", '"Cap UX Settings"'));
	assert.ok(leak("scripts/x.mjs", "run zworm upload"));
	assert.ok(leak("apps/desktop-gpui/src/x.rs", '"cap-ux-settings"'));
	assert.ok(leak("README.md", "Cap UX records locally."));
	assert.ok(!leak("README.md", "Worm records locally."));
	assert.ok(!leak("README.md", "Worm was previously named Cap UX."));
	assert.ok(!leak("crates/fork-brand/brand.json", '"display_name": "Worm"'));
	assert.ok(!leak("crates/x/src/lib.rs", '"com.cantrell.cap-ux.sharing"'));
	assert.ok(!leak("vendor/ux-walk/src/a.mjs", "Cap UX"));
	assert.ok(!leak("apps/desktop-gpui/src/x.rs", "capture and wormhole"));
});
