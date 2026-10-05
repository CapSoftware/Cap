import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: null as {
		id: string;
		stripeSubscriptionStatus?: string | null;
	} | null,
	video: null as { ownerId: string; metadata: unknown } | null,
	updates: [] as unknown[],
	puts: [] as { key: string; contentType?: string }[],
	deletes: [] as string[],
	revalidated: [] as string[],
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: true },
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => (mocks.video ? [mocks.video] : []),
			}),
		}),
		update: () => ({
			set: (values: unknown) => ({
				where: async () => {
					mocks.updates.push(values);
				},
			}),
		}),
	}),
}));

vi.mock("@cap/web-backend", () => ({
	S3Buckets: {
		getBucketAccess: () =>
			Effect.succeed([
				{
					putObject: (
						key: string,
						_body: Uint8Array,
						fields?: { contentType?: string },
					) =>
						Effect.sync(() => {
							mocks.puts.push({ key, contentType: fields?.contentType });
						}),
					deleteObject: (key: string) =>
						Effect.sync(() => {
							mocks.deletes.push(key);
						}),
				},
			]),
	},
}));

vi.mock("@/lib/server", () => ({
	runPromise: <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect),
}));

vi.mock("next/cache", () => ({
	revalidatePath: (path: string) => mocks.revalidated.push(path),
}));

import {
	resetLinkPreview,
	saveLinkPreview,
} from "@/actions/videos/link-preview";

const videoId = "video123";
const existingImage = {
	key: "link-previews/video123/old.jpg",
	width: 1200,
	height: 630,
	contentType: "image/jpeg",
	size: 100,
};

const jpeg = (width: number, height: number) => {
	const bytes = new Uint8Array(64);
	bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
	bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
	const view = new DataView(bytes.buffer);
	view.setUint16(25, height);
	view.setUint16(27, width);
	return bytes;
};

const form = (fields: Record<string, string | File>) => {
	const data = new FormData();
	data.set("videoId", videoId);
	for (const [key, value] of Object.entries(fields)) data.set(key, value);
	return data;
};

const sqlText = (value: unknown): string => {
	const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? [];
	return chunks
		.map((chunk) => {
			if (typeof chunk === "string") return chunk;
			if (chunk && typeof chunk === "object" && "value" in chunk) {
				const inner = (chunk as { value: unknown }).value;
				return Array.isArray(inner) ? inner.join("") : String(inner);
			}
			return "?";
		})
		.join("");
};

const storedJson = () => {
	const values = mocks.updates[0] as { metadata: unknown };
	const chunks = (values.metadata as { queryChunks: unknown[] }).queryChunks;
	const json = chunks.find(
		(chunk): chunk is string =>
			typeof chunk === "string" && chunk.startsWith("{"),
	);
	return json ? JSON.parse(json) : null;
};

describe("saveLinkPreview", () => {
	beforeEach(() => {
		mocks.user = { id: "owner", stripeSubscriptionStatus: "active" };
		mocks.video = { ownerId: "owner", metadata: null };
		mocks.updates = [];
		mocks.puts = [];
		mocks.deletes = [];
		mocks.revalidated = [];
	});

	it("requires a signed-in user", async () => {
		mocks.user = null;
		await expect(saveLinkPreview(form({ title: "Hi" }))).rejects.toThrow(
			"Unauthorized",
		);
		expect(mocks.updates).toHaveLength(0);
	});

	it("only lets the owner change the preview", async () => {
		mocks.user = { id: "someone-else", stripeSubscriptionStatus: "active" };
		await expect(saveLinkPreview(form({ title: "Hi" }))).rejects.toThrow(
			"permission",
		);
		expect(mocks.updates).toHaveLength(0);
		expect(mocks.puts).toHaveLength(0);
	});

	it.each([null, "canceled", "unpaid"])(
		"requires Cap Pro (subscription status %s) before touching storage",
		async (stripeSubscriptionStatus) => {
			mocks.user = { id: "owner", stripeSubscriptionStatus };
			const result = await saveLinkPreview(
				form({
					title: "Hi",
					image: new File([jpeg(1200, 630)], "x.jpg", { type: "image/jpeg" }),
				}),
			);
			expect(result).toEqual({
				success: false,
				errors: {},
				upgradeRequired: true,
			});
			expect(mocks.updates).toHaveLength(0);
			expect(mocks.puts).toHaveLength(0);
		},
	);

	it("rejects an image whose bytes are not a JPEG or PNG, whatever it claims", async () => {
		const result = await saveLinkPreview(
			form({
				image: new File(['<svg onload="alert(1)"/>'], "x.png", {
					type: "image/png",
				}),
			}),
		);
		expect(result).toMatchObject({
			success: false,
			errors: { image: expect.any(String) },
		});
		expect(mocks.puts).toHaveLength(0);
		expect(mocks.updates).toHaveLength(0);
	});

	it("rejects text past the limits", async () => {
		const result = await saveLinkPreview(form({ title: "a".repeat(101) }));
		expect(result).toMatchObject({
			success: false,
			errors: { title: expect.any(String) },
		});
		expect(mocks.updates).toHaveLength(0);
	});

	it("stores sanitized text and the uploaded image, and drops the old one", async () => {
		mocks.video = {
			ownerId: "owner",
			metadata: { linkPreview: { version: 1, image: existingImage } },
		};
		const result = await saveLinkPreview(
			form({
				title: "  Launch‮ recap ",
				description: "What shipped",
				image: new File([jpeg(1200, 630)], "anything.gif", {
					type: "image/gif",
				}),
			}),
		);

		expect(result.success).toBe(true);
		expect(mocks.puts).toHaveLength(1);
		expect(mocks.puts[0]?.key).toMatch(
			/^link-previews\/video123\/[a-z0-9]+\.jpg$/,
		);
		expect(mocks.puts[0]?.contentType).toBe("image/jpeg");
		expect(
			sqlText((mocks.updates[0] as { metadata: unknown }).metadata),
		).toContain("JSON_SET(COALESCE(");
		const stored = storedJson();
		expect(stored).toMatchObject({
			version: 1,
			title: "Launch recap",
			description: "What shipped",
			image: {
				key: mocks.puts[0]?.key,
				width: 1200,
				height: 630,
				contentType: "image/jpeg",
			},
		});
		expect(mocks.deletes).toEqual([existingImage.key]);
		expect(mocks.revalidated).toEqual([`/s/${videoId}`]);
		if (!result.success) return;
		expect(result.linkPreview?.imageUrl).toMatch(
			/^\/api\/video\/link-preview\?videoId=video123&v=/,
		);
	});

	it("keeps the stored image when only the text changes", async () => {
		mocks.video = {
			ownerId: "owner",
			metadata: { linkPreview: { version: 1, image: existingImage } },
		};
		await saveLinkPreview(form({ title: "New title" }));
		expect(storedJson()).toMatchObject({ image: existingImage });
		expect(mocks.deletes).toHaveLength(0);
	});

	it("clears everything when every field is blank", async () => {
		mocks.video = {
			ownerId: "owner",
			metadata: { linkPreview: { version: 1, image: existingImage } },
		};
		const result = await saveLinkPreview(
			form({ title: " ", description: "", removeImage: "1" }),
		);
		expect(result).toEqual({ success: true, linkPreview: null });
		expect(
			sqlText((mocks.updates[0] as { metadata: unknown }).metadata),
		).toContain("JSON_REMOVE(");
		expect(mocks.deletes).toEqual([existingImage.key]);
	});
});

describe("resetLinkPreview", () => {
	beforeEach(() => {
		mocks.video = {
			ownerId: "owner",
			metadata: {
				linkPreview: { version: 1, title: "x", image: existingImage },
			},
		};
		mocks.updates = [];
		mocks.deletes = [];
	});

	it("lets a downgraded owner take their preview down", async () => {
		mocks.user = { id: "owner", stripeSubscriptionStatus: "canceled" };
		await expect(resetLinkPreview(videoId as never)).resolves.toEqual({
			success: true,
			linkPreview: null,
		});
		expect(
			sqlText((mocks.updates[0] as { metadata: unknown }).metadata),
		).toContain("JSON_REMOVE(");
		expect(mocks.deletes).toEqual([existingImage.key]);
	});

	it("is owner only", async () => {
		mocks.user = { id: "someone-else", stripeSubscriptionStatus: "active" };
		await expect(resetLinkPreview(videoId as never)).rejects.toThrow(
			"permission",
		);
		expect(mocks.updates).toHaveLength(0);
	});
});
