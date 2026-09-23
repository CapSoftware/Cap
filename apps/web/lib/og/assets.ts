import { readFile } from "node:fs/promises";
import path from "node:path";

// Baked by scripts/og-sky/render.py: the painted hero sky, the Instant-mode
// mesh used for product frames, and the desktop wallpaper. Satori can't draw
// clouds or grain, so they ship as JPEGs and are inlined as data URIs.
const FILES = {
	skySplit: "sky-split.jpg",
	skyCenter: "sky-center.jpg",
	mesh: "mesh-instant.jpg",
	wallpaper: "wallpaper.jpg",
} as const;

export type OgAssets = Record<keyof typeof FILES, string>;

let assetsPromise: Promise<OgAssets> | null = null;

const loadAsset = async (file: string) => {
	const data = await readFile(
		path.join(process.cwd(), "lib", "og", "assets", file),
	);
	return `data:image/jpeg;base64,${data.toString("base64")}`;
};

export const loadOgAssets = () => {
	assetsPromise ??= Promise.all(
		Object.entries(FILES).map(
			async ([key, file]) => [key, await loadAsset(file)] as const,
		),
	)
		.then((entries) => Object.fromEntries(entries) as OgAssets)
		.catch((error) => {
			assetsPromise = null;
			throw error;
		});
	return assetsPromise;
};
