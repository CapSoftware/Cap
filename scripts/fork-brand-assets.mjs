import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { brand } from "./fork-brand.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const branding = path.join(root, "apps/desktop-gpui/assets/branding");
export const masterPath = path.join(branding, "brand.svg");
const TOKENS_OUTSIDE_THE_ART = new Set(["ink", "ink-dark"]);

export function applyPalette(master, palette = brand.palette) {
	const painted = new Set();
	const result = master.replace(
		/<(linearGradient|radialGradient) id="([a-z-]+)"([^>]*)>([\s\S]*?)<\/\1>/g,
		(_element, kind, id, attributes, stops) => {
			const token = palette[id];
			if (token === undefined) {
				throw new Error(
					`brand.svg paints ${id}, which brand.json's palette lacks`,
				);
			}
			const colors = [token].flat();
			const count = stops.match(/stop-color="/g)?.length ?? 0;
			if (colors.length !== count) {
				throw new Error(`palette ${id} needs ${count} colour(s)`);
			}
			let index = 0;
			painted.add(id);
			return `<${kind} id="${id}"${attributes}>${stops.replace(
				/stop-color="[^"]*"/g,
				() => `stop-color="${colors[index++]}"`,
			)}</${kind}>`;
		},
	);
	for (const token of Object.keys(palette)) {
		if (!painted.has(token) && !TOKENS_OUTSIDE_THE_ART.has(token)) {
			throw new Error(`palette ${token} paints nothing in brand.svg`);
		}
	}
	return result;
}

const open = (viewBox, width, height) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}" fill="none">`;

export function masterParts(master) {
	const defs = master.match(/<defs>[\s\S]*?<\/defs>/)?.[0];
	const parts = { defs };
	for (const match of master.matchAll(
		/<g id="([a-z-]+)"[^>]*>\n([\s\S]*?)\n<\/g>\n(?=<g id=|<\/svg>)/g,
	)) {
		parts[match[1]] = match[2];
	}
	for (const name of [
		"defs",
		"tile",
		"rays",
		"mark",
		"rings",
		"ground",
		"mark-small",
		"mark-tiny",
		"glyph",
		"wordmark",
	]) {
		if (!parts[name]) throw new Error(`brand.svg has no ${name} group`);
	}
	return parts;
}

export function tileSvg(parts, pixels) {
	const layers =
		pixels <= 48
			? [parts.tile, parts["mark-tiny"]]
			: pixels <= 192
				? [parts.tile, parts.rays, parts["mark-small"]]
				: [parts.tile, parts.rays, parts.mark, parts.rings, parts.ground];
	return `${open("0 0 1024 1024", pixels, pixels)}\n${parts.defs}\n${layers.join("\n")}\n</svg>\n`;
}

export function glyphBox(master) {
	const box = master.match(/<g id="glyph"[^>]*data-view-box="([^"]+)"/)?.[1];
	if (!box) throw new Error("brand.svg's glyph group needs data-view-box");
	const [, , width, height] = box.split(" ").map(Number);
	return { box, ratio: width / height };
}

export function glyphSvg(parts, { box }, height = 0) {
	const size = height ? ` height="${height}"` : "";
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"${size} fill="none">\n${parts.glyph}\n</svg>\n`;
}

export function logoMarkSvg(parts) {
	return `${open("100 100 824 824", 40, 40)}\n${parts.defs}\n${parts.tile}\n${parts.rays}\n${parts["mark-small"]}\n</svg>\n`;
}

export function logoFullSvg(parts, ink) {
	const wordmark = parts.wordmark.replace("<path ", `<path fill="${ink}" `);
	return `${open("0 0 103 40", 103, 40)}
<svg x="0" y="0" width="40" height="40" viewBox="100 100 824 824">
${parts.defs}
${parts.tile}
${parts.rays}
${parts["mark-small"]}
</svg>
<g transform="translate(46 27) scale(.0192)">
${wordmark}
</g>
</svg>
`;
}

function render(svg, pixels, output, height = pixels) {
	execFileSync(
		"rsvg-convert",
		["-w", `${pixels}`, "-h", `${height}`, "-o", output],
		{
			input: svg,
		},
	);
}

export function icoBytes(images) {
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ pixels, png }, index) => {
		const entry = 6 + 16 * index;
		header[entry] = pixels >= 256 ? 0 : pixels;
		header[entry + 1] = pixels >= 256 ? 0 : pixels;
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(png.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += png.length;
	});
	return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

export async function generateBrandAssets() {
	const master = applyPalette(await fs.readFile(masterPath, "utf8"));
	await fs.writeFile(masterPath, master);
	const parts = masterParts(master);
	const glyph = glyphBox(master);
	const work = await fs.mkdtemp(path.join(os.tmpdir(), "fork-brand-"));
	const app = path.join(branding, "app");
	await fs.mkdir(app, { recursive: true });
	const tile = (pixels, output) =>
		render(tileSvg(parts, pixels), pixels, output);
	try {
		const iconset = path.join(work, "icon.iconset");
		await fs.mkdir(iconset);
		for (const base of [16, 32, 128, 256, 512]) {
			tile(base, path.join(iconset, `icon_${base}x${base}.png`));
			tile(base * 2, path.join(iconset, `icon_${base}x${base}@2x.png`));
		}
		execFileSync("iconutil", [
			"-c",
			"icns",
			iconset,
			"-o",
			path.join(app, "icon.icns"),
		]);

		tile(32, path.join(app, "32x32.png"));
		tile(128, path.join(app, "128x128.png"));
		tile(256, path.join(app, "128x128@2x.png"));
		tile(1024, path.join(branding, "app-icon.png"));
		tile(512, path.join(branding, "dock-icon.png"));
		await fs.copyFile(
			path.join(branding, "dock-icon.png"),
			path.join(root, "apps/desktop-gpui/assets/dock-icon.png"),
		);
		await fs.copyFile(
			path.join(branding, "dock-icon.png"),
			path.join(root, "apps/cloud/public/icon.png"),
		);

		const images = [];
		for (const pixels of [16, 32, 48, 256]) {
			const output = path.join(work, `${pixels}.png`);
			tile(pixels, output);
			images.push({ pixels, png: await fs.readFile(output) });
		}
		await fs.writeFile(path.join(app, "icon.ico"), icoBytes(images));

		const trayHeight = 72;
		render(
			glyphSvg(parts, glyph),
			Math.round(trayHeight * glyph.ratio),
			path.join(
				root,
				"apps/desktop-gpui/assets/tray/tray-default-icon-ux-walk.png",
			),
			trayHeight,
		);
		await fs.writeFile(
			path.join(root, "apps/desktop-gpui/assets/icons/ux-walk.svg"),
			glyphSvg(parts, glyph),
		);

		await fs.writeFile(
			path.join(branding, "logo-mark.svg"),
			logoMarkSvg(parts),
		);
		await fs.writeFile(
			path.join(branding, "logo-full.svg"),
			logoFullSvg(parts, brand.palette.ink),
		);
		await fs.writeFile(
			path.join(branding, "logo-full-dark.svg"),
			logoFullSvg(parts, brand.palette["ink-dark"]),
		);
	} finally {
		await fs.rm(work, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	generateBrandAssets().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
