import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderEditorClipThumbnail } from "../../lib/editor-clip-thumbnails";

type NativeSession = Parameters<typeof renderEditorClipThumbnail>[0];

function fakeNative(response: Response, paths: string[]) {
	return {
		request: async (path: string) => {
			paths.push(path);
			return response;
		},
	} as unknown as NativeSession;
}

test("clip thumbnails preserve native JPEG bytes at the requested split time", async () => {
	const jpeg = await readFile(
		join(import.meta.dir, "../fixtures/exif-orientation-6.jpg"),
	);
	const paths: string[] = [];
	const result = await renderEditorClipThumbnail(
		fakeNative(
			new Response(jpeg, {
				headers: {
					"Content-Type": "image/jpeg",
					"Content-Length": String(jpeg.length),
				},
			}),
			paths,
		),
		2,
		1.5,
	);
	expect(paths).toEqual(["/clip-thumbnail/2/1500"]);
	expect(
		Buffer.from(result.slice("data:image/jpeg;base64,".length), "base64"),
	).toEqual(jpeg);
});

test("clip thumbnail requests reject invalid times and segments before native access", async () => {
	const paths: string[] = [];
	const native = fakeNative(new Response(null), paths);
	for (const [segment, time] of [
		[-1, 0],
		[0, -1],
		[0.5, 0],
		[0, Number.NaN],
		[0, 43_201],
	]) {
		await expect(
			renderEditorClipThumbnail(native, segment, time),
		).rejects.toThrow("Invalid clip thumbnail request");
	}
	expect(paths).toHaveLength(0);
});

test("clip thumbnails reject failed, oversized, and damaged native responses", async () => {
	const paths: string[] = [];
	await expect(
		renderEditorClipThumbnail(
			fakeNative(new Response(null, { status: 404 }), paths),
			0,
			0,
		),
	).rejects.toThrow("404");
	await expect(
		renderEditorClipThumbnail(
			fakeNative(
				new Response("bad", {
					headers: { "Content-Type": "text/plain", "Content-Length": "3" },
				}),
				paths,
			),
			0,
			0,
		),
	).rejects.toThrow("invalid format");
	await expect(
		renderEditorClipThumbnail(
			fakeNative(
				new Response("bad", {
					headers: {
						"Content-Type": "image/jpeg",
						"Content-Length": String(256 * 1024 + 1),
					},
				}),
				paths,
			),
			0,
			0,
		),
	).rejects.toThrow("invalid size");
	await expect(
		renderEditorClipThumbnail(
			fakeNative(
				new Response("bad", {
					headers: { "Content-Type": "image/jpeg", "Content-Length": "3" },
				}),
				paths,
			),
			0,
			0,
		),
	).rejects.toThrow("invalid size");
});
