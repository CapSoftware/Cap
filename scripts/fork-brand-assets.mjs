import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const branding = path.join(root, "apps/desktop-gpui/assets/branding");
export const masterPath = path.join(branding, "brand.svg");

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
		"mark",
		"rings",
		"star",
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
	const detail =
		pixels <= 32
			? parts["mark-tiny"]
			: pixels <= 48
				? parts["mark-small"]
				: pixels < 128
					? `${parts.mark}\n${parts.star}`
					: `${parts.mark}\n${parts.rings}\n${parts.star}`;
	return `${open("0 0 1024 1024", pixels, pixels)}\n${parts.defs}\n${parts.tile}\n${detail}\n</svg>\n`;
}

export function glyphSvg(parts, pixels) {
	return `${open("0 0 1024 1024", pixels, pixels)}\n${parts.glyph}\n</svg>\n`;
}

export function logoMarkSvg(parts) {
	return `${open("100 100 824 824", 40, 40)}\n${parts.defs}\n${parts.tile}\n${parts["mark-small"]}\n</svg>\n`;
}

export function logoFullSvg(parts, ink) {
	const wordmark = parts.wordmark.replace("<path ", `<path fill="${ink}" `);
	return `${open("0 0 103 40", 103, 40)}
<svg x="0" y="0" width="40" height="40" viewBox="100 100 824 824">
${parts.defs}
${parts.tile}
${parts["mark-small"]}
</svg>
<g transform="translate(46 27) scale(.0192)">
${wordmark}
</g>
</svg>
`;
}

function render(svg, pixels, output) {
	execFileSync(
		"rsvg-convert",
		["-w", `${pixels}`, "-h", `${pixels}`, "-o", output],
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
	const parts = masterParts(await fs.readFile(masterPath, "utf8"));
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

		render(
			glyphSvg(parts, 88),
			88,
			path.join(
				root,
				"apps/desktop-gpui/assets/tray/tray-default-icon-ux-walk.png",
			),
		);

		await fs.writeFile(
			path.join(branding, "logo-mark.svg"),
			logoMarkSvg(parts),
		);
		await fs.writeFile(
			path.join(branding, "logo-full.svg"),
			logoFullSvg(parts, "#12161F"),
		);
		await fs.writeFile(
			path.join(branding, "logo-full-dark.svg"),
			logoFullSvg(parts, "#FFFFFF"),
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
