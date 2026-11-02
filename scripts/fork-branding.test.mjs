import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { brand, brandLeaks } from "./fork-brand.mjs";
import {
	applyPalette,
	glyphBox,
	glyphSvg,
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
	const overrides = overlay.slice(overlay.indexOf("OVERRIDES"));
	for (const path of overlaidArt) {
		assert.ok(overrides.includes(`"${path}"`), `the overrides lost ${path}`);
	}
	assert.match(
		text("src/assets.rs"),
		/crate::ux_walk::assets::OVERRIDES\s*\.iter\(\)\s*\.chain\(Self::all\(\)\)/,
		"Assets::load must check the overrides first: it returns the first match",
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

test("the master carries brand.json's palette and nothing else", () => {
	const master = readFileSync(masterPath, "utf8");
	assert.equal(
		applyPalette(master),
		master,
		"brand.svg is stale: run node scripts/fork-brand-assets.mjs",
	);
	const art = master.slice(master.indexOf("</defs>"));
	const glyph = art.slice(
		art.indexOf('<g id="glyph"'),
		art.indexOf('<g id="wordmark"'),
	);
	assert.deepEqual(
		art.replace(glyph, "").match(/#[0-9a-f]{3,8}\b/gi) ?? [],
		[],
		"colours belong in brand.json's palette; paint with url(#token)",
	);
});

test("a skin swaps colours without new artwork", () => {
	const master = readFileSync(masterPath, "utf8");
	const blue = Object.fromEntries(
		Object.entries(brand.palette).map(([token, value]) => [
			token,
			Array.isArray(value) ? value.map(() => "#1E5BD8") : "#1E5BD8",
		]),
	);
	const skinned = applyPalette(master, blue);
	assert.notEqual(skinned, master);
	assert.equal(
		skinned.replace(/stop-color="[^"]*"/g, ""),
		master.replace(/stop-color="[^"]*"/g, ""),
	);
});

test("derived logos and glyphs are what the master generates", () => {
	const master = readFileSync(masterPath, "utf8");
	const parts = masterParts(master);
	for (const [file, svg] of [
		["assets/branding/logo-mark.svg", logoMarkSvg(parts)],
		["assets/branding/logo-full.svg", logoFullSvg(parts, brand.palette.ink)],
		[
			"assets/branding/logo-full-dark.svg",
			logoFullSvg(parts, brand.palette["ink-dark"]),
		],
		["assets/icons/ux-walk.svg", glyphSvg(parts, glyphBox(master))],
	]) {
		assert.equal(
			text(file),
			svg,
			`${file} is stale: run node scripts/fork-brand-assets.mjs`,
		);
	}
	assert.doesNotMatch(master, /star/i, "the Worm mark has no star");
});

test("every generated image exists at its size", () => {
	const size = (file) => read(file).readUInt32BE(16);
	for (const [file, pixels] of [
		["assets/branding/app-icon.png", 1024],
		["assets/branding/dock-icon.png", 512],
		["assets/branding/app/32x32.png", 32],
		["assets/branding/app/128x128.png", 128],
		["assets/branding/app/128x128@2x.png", 256],
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
