import { afterAll, beforeAll, expect, test } from "bun:test";
import { downloadEditorMedia } from "../../lib/editor-media";
import { editorProcessEnv } from "../../lib/editor-process";

const expectedIdentity = JSON.stringify("expected");
const body = "abc";
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/redirect") {
			return new Response(null, {
				status: 302,
				headers: { location: "/matching" },
			});
		}
		return new Response(body, {
			headers: {
				"content-length": String(body.length),
				...(path === "/matching"
					? { etag: expectedIdentity }
					: path === "/changed"
						? { etag: JSON.stringify("changed") }
						: {}),
			},
		});
	},
});

const previousHttpMedia = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
beforeAll(() => {
	process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
});
afterAll(() => {
	if (previousHttpMedia === undefined) {
		delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	} else {
		process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousHttpMedia;
	}
	server.stop(true);
});

function source(
	path: string,
	objectIdentity: string | null = expectedIdentity,
) {
	return {
		url: `http://127.0.0.1:${server.port}${path}`,
		contentType: "video/mp4" as const,
		size: body.length,
		objectIdentity,
	};
}

test("native editor process environment excludes worker credentials", () => {
	const previousWebhook = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	const previousAws = process.env.AWS_SECRET_ACCESS_KEY;
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = "webhook-secret-sentinel";
	process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-sentinel";
	try {
		const env = editorProcessEnv("internal-token-sentinel");
		expect(env.CAP_WEB_EDITOR_INTERNAL_TOKEN).toBe("internal-token-sentinel");
		expect(env.MEDIA_SERVER_WEBHOOK_SECRET).toBeUndefined();
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
	} finally {
		if (previousWebhook === undefined) {
			delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
		} else {
			process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousWebhook;
		}
		if (previousAws === undefined) {
			delete process.env.AWS_SECRET_ACCESS_KEY;
		} else {
			process.env.AWS_SECRET_ACCESS_KEY = previousAws;
		}
	}
});

test("rejects a source when its pinned object identity is missing", async () => {
	await expect(downloadEditorMedia(source("/missing"))).rejects.toThrow(
		"Editor source identity changed before download",
	);
});

test("rejects a source when its pinned object identity changes", async () => {
	await expect(downloadEditorMedia(source("/changed"))).rejects.toThrow(
		"Editor source identity changed before download",
	);
});

test("rejects source redirects before downloading another object", async () => {
	await expect(downloadEditorMedia(source("/redirect"))).rejects.toThrow(
		"Editor source download failed: 302",
	);
});

test("downloads the exact pinned object and supports legacy unpinned sources", async () => {
	for (const input of [source("/matching"), source("/missing", null)]) {
		const result = await downloadEditorMedia(input);
		try {
			expect(result.size).toBe(body.length);
		} finally {
			await result.cleanup();
		}
	}
});
