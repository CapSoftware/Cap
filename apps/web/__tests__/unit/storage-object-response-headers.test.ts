import { Effect } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	head: vi.fn(),
	read: vi.fn(),
	signedUrl: null as string | null,
	video: {
		id: "video",
		ownerId: "owner",
		source: { type: "desktopMP4" },
	},
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect, Option } = await import("effect");
	return {
		provideOptionalAuth: (effect: unknown) => effect,
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					mocks.signedUrl
						? { getSignedObjectUrl: () => Effect.succeed(mocks.signedUrl) }
						: { headObject: mocks.head, getObjectResponse: mocks.read },
				]),
		},
		Videos: Effect.succeed({
			getByIdForViewing: () => Effect.succeed(Option.some([mocks.video])),
		}),
		VideosRepo: Effect.succeed({
			getById: () => Effect.succeed(Option.some([mocks.video])),
		}),
		verifyStorageObjectToken: () => null,
	};
});
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ MEDIA_SERVER_WEBHOOK_SECRET: "test-media-secret" }),
}));
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});
vi.mock("@/utils/helpers", () => ({ CACHE_CONTROL_HEADERS: {} }));

import { GET, HEAD } from "@/app/api/storage/object/route";

const objectUrl = (key: string) =>
	`https://cap.test/api/storage/object?videoId=video&key=${encodeURIComponent(key)}`;

const upstream = (contentType: string | null, init: ResponseInit = {}) => {
	const headers = new Headers(init.headers);
	const response = new Response("data", {
		status: init.status ?? 200,
		headers,
	});
	if (contentType) {
		response.headers.set("Content-Type", contentType);
	} else {
		response.headers.delete("Content-Type");
	}
	return response;
};

const expectContentHeaders = (response: Response) => {
	expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(response.headers.get("Content-Security-Policy")).toBe(
		"sandbox; default-src 'none'",
	);
};

describe("storage object content headers", () => {
	beforeEach(() => {
		mocks.head.mockReset();
		mocks.read.mockReset();
		mocks.signedUrl = null;
	});

	it.each([
		["owner/video/result.mp4", "video/mp4"],
		["owner/video/raw-upload.webm", "audio/webm"],
		["owner/video/raw-upload.mov", "video/quicktime"],
		["owner/video/segments/video/segment_001.m4s", "video/mp4"],
		["owner/video/combined-source/segment_1.ts", "video/mp2t"],
		["owner/video/stream.m3u8", "application/x-mpegURL"],
		["owner/video/screenshot/screen-capture.jpg", "image/jpeg"],
		["owner/video/screenshot/screen-capture.png", "image/png"],
		["owner/video/animated-preview.gif", "image/gif"],
		["owner/video/transcription.vtt", "text/vtt; charset=utf-8"],
		["owner/video/comments/comment/media.m4a", "audio/mp4"],
		["owner/video/comments/comment/media.mp3", "audio/mpeg"],
	])("serves %s inline as %s", async (key, contentType) => {
		mocks.read.mockReturnValue(Effect.succeed(upstream(contentType)));
		const response = await GET(new NextRequest(objectUrl(key)));
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(contentType);
		expect(response.headers.get("Content-Disposition")).toBeNull();
		expectContentHeaders(response);
		expect(await response.text()).toBe("data");
	});

	it.each([
		"text/html",
		"text/html; charset=utf-8",
		"image/svg+xml",
		"application/xhtml+xml",
		"application/pdf",
		"text/plain",
		"application/javascript",
	])("serves %s as an attachment", async (contentType) => {
		mocks.read.mockReturnValue(Effect.succeed(upstream(contentType)));
		const response = await GET(
			new NextRequest(objectUrl("owner/video/upload.bin")),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"application/octet-stream",
		);
		expect(response.headers.get("Content-Disposition")).toBe("attachment");
		expectContentHeaders(response);
	});

	it("serves an upstream without a Content-Type as an attachment", async () => {
		const source = upstream(null);
		expect(source.headers.get("Content-Type")).toBeNull();
		mocks.read.mockReturnValue(Effect.succeed(source));
		const response = await GET(
			new NextRequest(objectUrl("owner/video/upload.bin")),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"application/octet-stream",
		);
		expect(response.headers.get("Content-Disposition")).toBe("attachment");
		expectContentHeaders(response);
	});

	it("keeps byte-range responses intact", async () => {
		mocks.read.mockReturnValue(
			Effect.succeed(
				upstream("video/mp4", {
					status: 206,
					headers: {
						"Content-Range": "bytes 0-3/100",
						"Content-Length": "4",
					},
				}),
			),
		);
		const response = await GET(
			new NextRequest(objectUrl("owner/video/result.mp4"), {
				headers: { Range: "bytes=0-3" },
			}),
		);
		expect(mocks.read).toHaveBeenCalledWith(
			"owner/video/result.mp4",
			"bytes=0-3",
			{ signal: expect.any(AbortSignal) },
		);
		expect(response.status).toBe(206);
		expect(response.headers.get("Content-Range")).toBe("bytes 0-3/100");
		expect(response.headers.get("Content-Length")).toBe("4");
		expect(response.headers.get("Accept-Ranges")).toBe("bytes");
		expect(response.headers.get("Content-Type")).toBe("video/mp4");
		expectContentHeaders(response);
	});

	it("applies the same content headers to HEAD responses", async () => {
		mocks.head.mockReturnValueOnce(
			Effect.succeed({ ContentLength: 100, ContentType: "video/mp4" }),
		);
		const inline = await HEAD(
			new NextRequest(objectUrl("owner/video/result.mp4"), {
				method: "HEAD",
			}),
		);
		expect(inline.headers.get("Content-Type")).toBe("video/mp4");
		expect(inline.headers.get("Content-Disposition")).toBeNull();
		expectContentHeaders(inline);

		mocks.head.mockReturnValueOnce(
			Effect.succeed({ ContentLength: 100, ContentType: "text/html" }),
		);
		const attachment = await HEAD(
			new NextRequest(objectUrl("owner/video/page.html"), {
				method: "HEAD",
			}),
		);
		expect(attachment.headers.get("Content-Type")).toBe(
			"application/octet-stream",
		);
		expect(attachment.headers.get("Content-Disposition")).toBe("attachment");
		expectContentHeaders(attachment);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("keeps redirecting to signed URLs without proxying bytes", async () => {
		mocks.signedUrl = "https://bucket.example/owner/video/result.mp4?sig=1";
		const response = await GET(
			new NextRequest(objectUrl("owner/video/result.mp4")),
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(mocks.signedUrl);
		expect(mocks.read).not.toHaveBeenCalled();
	});
});
