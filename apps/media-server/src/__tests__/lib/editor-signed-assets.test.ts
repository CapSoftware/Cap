import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageSignedEditorAsset } from "../../lib/editor-signed-assets";

test("signed assets recover from changed identities, same-sized tampering, and missing receipts", async () => {
	const previousHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
	const root = await mkdtemp(join(tmpdir(), "cap-editor-signed-asset-test-"));
	const project = join(root, "recording.cap");
	let server: ReturnType<typeof Bun.serve> | null = null;
	let contents = "AAAA";
	let identity = '"first"';
	let requests = 0;
	try {
		await mkdir(project);
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests++;
				if (request.headers.get("if-match") !== identity) {
					return new Response(null, { status: 412 });
				}
				return new Response(contents, {
					headers: {
						"Content-Length": String(contents.length),
						ETag: identity,
					},
				});
			},
		});
		const asset = {
			path: "content/images/asset.png",
			name: "Overlay",
			url: `http://127.0.0.1:${server.port}/asset`,
			size: 4,
			contentType: "image/png",
			objectIdentity: identity,
		};
		const probe = async (path: string) => ({
			contents: await readFile(path, "utf8"),
		});
		const first = await stageSignedEditorAsset(project, asset, probe);
		expect(first.contents).toBe("AAAA");
		expect(await stageSignedEditorAsset(project, asset, probe)).toEqual(first);
		expect(requests).toBe(1);
		await writeFile(join(project, asset.path), "ZZZZ");
		expect((await stageSignedEditorAsset(project, asset, probe)).contents).toBe(
			"AAAA",
		);
		expect(requests).toBe(2);
		contents = "BBBB";
		identity = '"second"';
		const revised = { ...asset, objectIdentity: identity };
		expect(
			(await stageSignedEditorAsset(project, revised, probe)).contents,
		).toBe("BBBB");
		expect(requests).toBe(3);
		await rm(join(project, ".editor-asset-receipts"), {
			recursive: true,
			force: true,
		});
		expect(
			(await stageSignedEditorAsset(project, revised, probe)).contents,
		).toBe("BBBB");
		expect(requests).toBe(4);
	} finally {
		server?.stop(true);
		await rm(root, { recursive: true, force: true });
		if (previousHttp === undefined)
			delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
		else process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousHttp;
	}
});

test("concurrent staging waits for a complete signed file and never trusts an unpinned response", async () => {
	const previousHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
	const root = await mkdtemp(
		join(tmpdir(), "cap-editor-signed-concurrent-test-"),
	);
	const project = join(root, "recording.cap");
	let server: ReturnType<typeof Bun.serve> | null = null;
	let requests = 0;
	try {
		await mkdir(project);
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests++;
				await new Promise((resolve) => setTimeout(resolve, 30));
				const noIdentity = new URL(request.url).pathname === "/no-identity";
				return new Response("DATA", {
					headers: {
						"Content-Length": "4",
						...(noIdentity ? {} : { ETag: '"same"' }),
					},
				});
			},
		});
		const asset = {
			path: "content/images/concurrent.png",
			name: "Overlay",
			url: `http://127.0.0.1:${server.port}/asset`,
			size: 4,
			contentType: "image/png",
			objectIdentity: '"same"',
		};
		const probe = async (path: string) => ({
			contents: await readFile(path, "utf8"),
		});
		const staged = await Promise.all([
			stageSignedEditorAsset(project, asset, probe),
			stageSignedEditorAsset(project, asset, probe),
		]);
		expect(staged.map((result) => result.contents)).toEqual(["DATA", "DATA"]);
		expect(requests).toBe(1);
		const withoutEtag = {
			...asset,
			path: "content/images/no-identity.png",
			url: `http://127.0.0.1:${server.port}/no-identity`,
		};
		await expect(
			stageSignedEditorAsset(project, withoutEtag, probe),
		).rejects.toThrow("identity changed");
		expect(await Bun.file(join(project, withoutEtag.path)).exists()).toBe(
			false,
		);
		const unpinned = {
			...asset,
			path: "content/images/unpinned.png",
			objectIdentity: null,
		};
		await stageSignedEditorAsset(project, unpinned, probe);
		await stageSignedEditorAsset(project, unpinned, probe);
		expect(requests).toBe(4);
	} finally {
		server?.stop(true);
		await rm(root, { recursive: true, force: true });
		if (previousHttp === undefined)
			delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
		else process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousHttp;
	}
});
