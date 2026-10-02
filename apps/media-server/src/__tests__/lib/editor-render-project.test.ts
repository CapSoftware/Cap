import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listEditorRenderProject,
	uploadEditorRenderProject,
} from "../../lib/editor-render-project";

const previousHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
const previousWallpapers = process.env.CAP_WEB_EDITOR_WALLPAPER_DIR;
process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
const roots: string[] = [];
const received = new Map<string, number>();
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		if (request.method !== "PUT") return new Response(null, { status: 405 });
		const url = new URL(request.url);
		if (url.pathname === "/fail") return new Response(null, { status: 403 });
		received.set(url.pathname, (await request.arrayBuffer()).byteLength);
		return new Response(null, { status: 200 });
	},
});

afterEach(async () => {
	received.clear();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

afterAll(() => {
	server.stop(true);
	if (previousHttp === undefined)
		delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	else process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousHttp;
	if (previousWallpapers === undefined)
		delete process.env.CAP_WEB_EDITOR_WALLPAPER_DIR;
	else process.env.CAP_WEB_EDITOR_WALLPAPER_DIR = previousWallpapers;
});

async function makeProject() {
	const root = await mkdtemp(join(tmpdir(), "cap-render-project-test-"));
	roots.push(root);
	const project = join(root, "source.cap");
	const segment = join(project, "content/segments/segment-1");
	await mkdir(segment, { recursive: true });
	await mkdir(join(project, "content/videos"), { recursive: true });
	await mkdir(join(project, "output"), { recursive: true });
	const wallpapers = join(root, "backgrounds");
	await mkdir(join(wallpapers, "blue"), { recursive: true });
	process.env.CAP_WEB_EDITOR_WALLPAPER_DIR = wallpapers;
	await Promise.all([
		writeFile(
			join(project, "recording-meta.json"),
			JSON.stringify({ segments: [{ display: { path: "x" } }] }),
		),
		writeFile(join(project, "project-config.json"), "{}"),
		writeFile(join(project, "content/videos/clip.webm"), Buffer.alloc(900)),
		writeFile(join(project, "output/result.mp4"), Buffer.alloc(10)),
		writeFile(join(wallpapers, "blue/sky.jpg"), Buffer.alloc(77)),
	]);
	await link(
		join(project, "content/videos/clip.webm"),
		join(segment, "display.webm"),
	);
	return project;
}

describe("editor render projects", () => {
	test("list project files without exports and share inodes for staged links", async () => {
		const project = await makeProject();
		const listing = await listEditorRenderProject(project);
		expect(listing.recordingMeta).toEqual({
			segments: [{ display: { path: "x" } }],
		});
		const paths = listing.files.map((file) => file.path);
		expect(paths).not.toContain("output/result.mp4");
		const clip = listing.files.find(
			(file) => file.path === "content/videos/clip.webm",
		);
		const staged = listing.files.find(
			(file) => file.path === "content/segments/segment-1/display.webm",
		);
		expect(clip?.size).toBe(900);
		expect(staged?.inode).toBe(clip?.inode ?? "");
	});

	test("upload requested files and wallpapers and report stored sizes", async () => {
		const project = await makeProject();
		const origin = `http://127.0.0.1:${server.port}`;
		const result = await uploadEditorRenderProject(project, {
			files: [
				{ path: "project-config.json", url: `${origin}/config` },
				{
					path: "content/segments/segment-1/display.webm",
					url: `${origin}/display`,
				},
			],
			wallpapers: [{ file: "blue/sky.jpg", url: `${origin}/wallpaper` }],
		});
		expect(result.files).toEqual([
			{ path: "project-config.json", size: 2 },
			{ path: "content/segments/segment-1/display.webm", size: 900 },
		]);
		expect(result.wallpapers).toEqual([{ file: "blue/sky.jpg", size: 77 }]);
		expect(received.get("/display")).toBe(900);
		expect(received.get("/wallpaper")).toBe(77);
	});

	test("refuse files outside the project, escaping wallpapers and failed uploads", async () => {
		const project = await makeProject();
		const origin = `http://127.0.0.1:${server.port}`;
		for (const uploads of [
			{
				files: [{ path: "output/result.mp4", url: `${origin}/a` }],
				wallpapers: [],
			},
			{ files: [{ path: "../secret", url: `${origin}/a` }], wallpapers: [] },
			{
				files: [],
				wallpapers: [{ file: "../blue/sky.jpg", url: `${origin}/a` }],
			},
			{
				files: [{ path: "project-config.json", url: `${origin}/fail` }],
				wallpapers: [],
			},
			{
				files: [{ path: "project-config.json", url: "ftp://127.0.0.1/a" }],
				wallpapers: [],
			},
		]) {
			await expect(
				uploadEditorRenderProject(project, uploads),
			).rejects.toThrow();
		}
	});
});
