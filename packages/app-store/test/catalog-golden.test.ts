import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../src/build";
import type { ImageInfo } from "../src/image-info";
import { type Manifest, parseManifest } from "../src/manifest";
import { contentHashOf, type LoadedApp } from "../src/validate";

const fixture = join(import.meta.dirname, "fixtures/catalog.golden.json");

function fakeApp(
	manifest: Manifest,
	images: Record<string, ImageInfo>,
): LoadedApp {
	const files = new Map<string, Uint8Array>();
	const infos = new Map<string, ImageInfo>();
	for (const [path, info] of Object.entries(images)) {
		files.set(path, new TextEncoder().encode(`${manifest.id}:${path}`));
		infos.set(path, info);
	}
	files.set(
		"manifest.json",
		new TextEncoder().encode(JSON.stringify(manifest)),
	);
	return {
		id: manifest.id,
		dir: `/apps/${manifest.id}`,
		manifest,
		files,
		images: infos,
		readme: `# ${manifest.name}\n\nFixture app.`,
		contentHash: contentHashOf(files),
	};
}

function manifest(input: unknown): Manifest {
	const parsed = parseManifest(input);
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
	return parsed.manifest;
}

const author = { name: "Fixture", github: "fixture" };
const icon = { format: "png", width: 512, height: 512 } as const;

const contentApp = fakeApp(
	manifest({
		apiVersion: 1,
		id: "fixture-content",
		name: "Fixture Content",
		version: "1.2.3",
		description: "Every kind of content an app can add.",
		author,
		license: "MIT",
		categories: ["backgrounds", "captions", "color"],
		backgrounds: [
			{ id: "photo", name: "Photo", image: "backgrounds/photo.jpg" },
			{
				id: "sunset",
				name: "Sunset",
				gradient: { from: "#FF7E5F", to: "#6A3093", angle: 135 },
			},
			{ id: "ink", name: "Ink", color: "#111827" },
		],
		captionStyles: [
			{
				id: "bold",
				name: "Bold",
				description: "Big and bold",
				fontWeight: 700,
				size: 64,
				color: "#FFFFFF",
				backgroundColor: "#000000",
				backgroundOpacity: 0,
				outline: true,
				outlineColor: "#000000",
				highlightColor: "#FFD43B",
				activeWordHighlight: true,
				highlightStyle: "pill",
				animation: "pop",
				uppercase: true,
				fadeDuration: 0.12,
			},
		],
		colorLooks: [
			{
				id: "warm",
				name: "Warm",
				values: { temperature: 0.3, vignette: 0.2, splitTone: -0.1 },
			},
		],
	}),
	{
		"icon.png": icon,
		"backgrounds/photo.jpg": { format: "jpeg", width: 2560, height: 1440 },
	},
);

const connectionApp = fakeApp(
	manifest({
		apiVersion: 1,
		id: "fixture-connection",
		name: "Fixture Connection",
		version: "2.0.0",
		description: "A connection with settings, events and actions.",
		author,
		license: "Apache-2.0",
		categories: ["productivity"],
		privacyPolicy: "https://fixture.dev/privacy",
		connection: {
			url: "https://fixture.dev/cap",
			permissions: ["cap.transcript"],
			events: ["cap.ready", "cap.transcript.ready"],
			settings: [
				{ key: "token", type: "secret", label: "Token", required: true },
				{
					key: "mode",
					type: "select",
					label: "Mode",
					options: [{ value: "all", label: "All" }],
					default: "all",
				},
				{ key: "enabled", type: "toggle", label: "Enabled", default: true },
			],
			actions: [{ id: "send", title: "Send to Fixture", target: "cap" }],
		},
	}),
	{ "icon.png": icon },
);

describe("catalog golden", () => {
	it("matches the fixture the desktop app parses", async () => {
		const { catalog } = buildCatalog([contentApp, connectionApp], {
			assetBaseUrl: "/app-store",
		});
		const json = `${JSON.stringify(catalog, null, "\t")}\n`;
		if (process.env.UPDATE_GOLDEN === "1") {
			await writeFile(fixture, json);
		}
		expect(JSON.parse(json)).toEqual(
			JSON.parse(await readFile(fixture, "utf8")),
		);
	});
});
