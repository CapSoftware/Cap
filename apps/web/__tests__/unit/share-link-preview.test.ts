import { describe, expect, it } from "vitest";
import {
	cropBackgroundStyle,
	cropSourceRect,
	DEFAULT_CROP,
	panCrop,
} from "@/app/s/[videoId]/_components/link-preview/link-preview-crop";
import {
	inspectLinkPreviewImage,
	isLinkPreviewImageKey,
	LINK_PREVIEW_IMAGE_MAX_BYTES,
	type LinkPreviewAccess,
	linkPreviewAccessKey,
	linkPreviewDisplayHost,
	linkPreviewImageKey,
	linkPreviewImagePath,
	linkPreviewImageVersion,
	readLinkPreview,
	sanitizeLinkPreviewText,
	toLinkPreviewState,
	validateLinkPreviewText,
} from "@/lib/share-link-preview";

const png = (width: number, height: number, length = 64) => {
	const bytes = new Uint8Array(length);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
};

const jpeg = (width: number, height: number) => {
	const bytes = new Uint8Array(64);
	// SOI, an APP0 segment of 16 bytes, then a baseline SOF0 frame header.
	bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
	const sof = 2 + 2 + 0x10;
	bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], sof);
	const view = new DataView(bytes.buffer);
	view.setUint16(sof + 5, height);
	view.setUint16(sof + 7, width);
	return bytes;
};

describe("sanitizeLinkPreviewText", () => {
	it("collapses whitespace and drops invisible and bidi override characters", () => {
		expect(sanitizeLinkPreviewText("  Demo\n\tday‮txt.exe​ \u0007 ")).toBe(
			"Demo daytxt.exe",
		);
	});

	it("keeps emoji joiners and ordinary punctuation", () => {
		expect(sanitizeLinkPreviewText('Team 👩‍💻 <launch> & "recap"')).toBe(
			'Team 👩‍💻 <launch> & "recap"',
		);
	});
});

describe("validateLinkPreviewText", () => {
	it("treats blank fields as the defaults", () => {
		expect(validateLinkPreviewText({ title: "   ", description: "" })).toEqual({
			ok: true,
			value: { title: null, description: null },
		});
	});

	it("rejects text past the hard limits", () => {
		const result = validateLinkPreviewText({
			title: "a".repeat(101),
			description: "b".repeat(301),
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.title).toBeDefined();
		expect(result.errors.description).toBeDefined();
	});
});

describe("inspectLinkPreviewImage", () => {
	it("accepts a 1200 × 630 PNG and JPEG by their bytes", () => {
		expect(inspectLinkPreviewImage(png(1200, 630))).toEqual({
			ok: true,
			contentType: "image/png",
			width: 1200,
			height: 630,
		});
		expect(inspectLinkPreviewImage(jpeg(1200, 630))).toEqual({
			ok: true,
			contentType: "image/jpeg",
			width: 1200,
			height: 630,
		});
	});

	it.each([
		[
			"an SVG",
			new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
		],
		["a GIF", new TextEncoder().encode("GIF89a°\u0004v\u0002")],
		["HTML", new TextEncoder().encode("<html><script>alert(1)</script>")],
		["nothing", new Uint8Array(0)],
	])("rejects %s", (_, bytes) => {
		expect(inspectLinkPreviewImage(bytes).ok).toBe(false);
	});

	it("rejects images that are too small, too large or the wrong shape", () => {
		expect(inspectLinkPreviewImage(png(400, 210)).ok).toBe(false);
		expect(inspectLinkPreviewImage(png(4800, 2520)).ok).toBe(false);
		expect(inspectLinkPreviewImage(png(1000, 1000)).ok).toBe(false);
		expect(inspectLinkPreviewImage(png(1200, 1200)).ok).toBe(false);
	});

	it("rejects files over the size limit", () => {
		expect(
			inspectLinkPreviewImage(png(1200, 630, LINK_PREVIEW_IMAGE_MAX_BYTES + 1))
				.ok,
		).toBe(false);
	});

	it("survives a truncated JPEG", () => {
		expect(
			inspectLinkPreviewImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2])),
		).toMatchObject({ ok: false });
	});
});

describe("stored link previews", () => {
	const key = linkPreviewImageKey("video123", "image/jpeg", "abc");

	it("keys images under the video's own prefix", () => {
		expect(key).toBe("link-previews/video123/abc.jpg");
		expect(isLinkPreviewImageKey("video123", key)).toBe(true);
		expect(isLinkPreviewImageKey("video999", key)).toBe(false);
		expect(
			isLinkPreviewImageKey("video123", "link-previews/video123/../x.jpg"),
		).toBe(false);
	});

	it("reads overrides and builds a versioned image path", () => {
		const stored = readLinkPreview(
			{
				linkPreview: {
					version: 1,
					title: " Launch  recap ",
					image: {
						key,
						width: 1200,
						height: 630,
						contentType: "image/jpeg",
						size: 1000,
					},
					updatedAt: "2026-10-05T00:00:00.000Z",
				},
			},
			"video123",
		);
		expect(stored?.title).toBe("Launch recap");
		expect(toLinkPreviewState("video123", stored)).toEqual({
			title: "Launch recap",
			description: null,
			imageUrl: "/api/video/link-preview?videoId=video123&v=abc",
		});
		expect(linkPreviewImagePath("video123", { key })).toContain("v=abc");
	});

	it("ignores an image that belongs to another video", () => {
		// A duplicated Cap copies its metadata; the copy must not serve or
		// delete the original's image.
		const stored = readLinkPreview(
			{
				linkPreview: {
					version: 1,
					title: "Copy",
					image: {
						key,
						width: 1200,
						height: 630,
						contentType: "image/jpeg",
						size: 1000,
					},
				},
			},
			"video999",
		);
		expect(stored?.image).toBeUndefined();
		expect(stored?.title).toBe("Copy");
	});

	it.each([null, "x", { linkPreview: "x" }, { linkPreview: { version: 2 } }])(
		"treats malformed metadata as no overrides: %j",
		(metadata) => {
			expect(readLinkPreview(metadata, "video123")).toBeNull();
		},
	);
});

describe("linkPreviewImageVersion", () => {
	const key = "link-previews/video123/abc.jpg";
	const open: LinkPreviewAccess = {
		public: true,
		hasPassword: false,
		allowedEmailDomain: null,
		spaces: [{ id: "space1", hasPassword: false }],
		organizationIds: ["org1"],
	};
	const version = (access: LinkPreviewAccess) =>
		linkPreviewImageVersion(key, linkPreviewAccessKey(access));

	it("moves to a new URL whenever who can see the video changes", () => {
		const base = version(open);
		expect(base).toMatch(/^abc-[0-9a-z]+$/);
		for (const changed of [
			{ ...open, public: false },
			{ ...open, hasPassword: true },
			{ ...open, allowedEmailDomain: "example.com" },
			{ ...open, spaces: [] },
			{ ...open, spaces: [{ id: "space1", hasPassword: true }] },
			{ ...open, organizationIds: ["org1", "org2"] },
		]) {
			expect(version(changed)).not.toBe(base);
		}
	});

	it("does not depend on the order sharing is listed in", () => {
		expect(
			version({
				...open,
				spaces: [
					{ id: "b", hasPassword: false },
					{ id: "a", hasPassword: false },
				],
			}),
		).toBe(
			version({
				...open,
				spaces: [
					{ id: "a", hasPassword: false },
					{ id: "b", hasPassword: false },
				],
			}),
		);
	});
});

describe("linkPreviewDisplayHost", () => {
	it("shows the custom domain when there is one", () => {
		expect(linkPreviewDisplayHost("Videos.Example.com", "https://cap.so")).toBe(
			"videos.example.com",
		);
		expect(linkPreviewDisplayHost(null, "https://cap.so")).toBe("cap.so");
	});
});

describe("link preview crop", () => {
	const source = { width: 1920, height: 1080 };

	it("covers the 1.91:1 window centred by default", () => {
		const rect = cropSourceRect(source, DEFAULT_CROP);
		expect(rect.width).toBe(1920);
		expect(rect.height).toBeCloseTo(1008);
		expect(rect.x).toBe(0);
		expect(rect.y).toBeCloseTo(36);
	});

	it("pans within the image and never past its edges", () => {
		const frame = { width: 480, height: 252 };
		const down = panCrop(source, DEFAULT_CROP, frame, 0, -1000);
		expect(down.focusY).toBe(1);
		expect(down.focusX).toBe(0.5);
		const zoomed = { ...DEFAULT_CROP, zoom: 2 };
		const left = panCrop(source, zoomed, frame, 100, 0);
		expect(left.focusX).toBeLessThan(0.5);
		expect(left.focusX).toBeGreaterThanOrEqual(0);
	});

	it("draws the frame exactly as the saved crop", () => {
		const style = cropBackgroundStyle(source, {
			zoom: 2,
			focusX: 0,
			focusY: 1,
		});
		expect(style.backgroundPosition).toBe("0% 100%");
		expect(style.backgroundSize).toBe("200% 214.28571428571428%");
	});
});
