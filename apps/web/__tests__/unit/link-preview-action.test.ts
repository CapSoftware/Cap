import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: null as {
		id: string;
		stripeSubscriptionStatus?: string | null;
	} | null,
	video: null as { ownerId: string; metadata: unknown } | null,
	rereads: [] as unknown[],
	affected: [] as number[],
	updates: [] as unknown[],
	conditions: [] as unknown[],
	puts: [] as { key: string; contentType?: string }[],
	deletes: [] as string[],
	revalidated: [] as string[],
	selects: 0,
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
				where: async () => {
					if (!mocks.video) return [];
					if (mocks.selects++ > 0 && mocks.rereads.length > 0) {
						mocks.video = { ...mocks.video, metadata: mocks.rereads.shift() };
					}
					return [mocks.video];
				},
			}),
		}),
		update: () => ({
			set: (values: unknown) => ({
				where: async (condition: unknown) => {
					mocks.updates.push(values);
					mocks.conditions.push(condition);
					return [{ affectedRows: mocks.affected.shift() ?? 1 }];
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
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return String(value);
	if ("queryChunks" in value) {
		return (value as { queryChunks: unknown[] }).queryChunks
			.map(sqlText)
			.join("");
	}
	if ("value" in value) {
		const inner = (value as { value: unknown }).value;
		return Array.isArray(inner) ? inner.map(sqlText).join("") : String(inner);
	}
	return "?";
};

const storedJson = () => {
	const values = mocks.updates.at(-1) as { metadata: unknown };
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
		mocks.rereads = [];
		mocks.affected = [];
		mocks.conditions = [];
		mocks.selects = 0;
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

	it("only writes over the image it read", async () => {
		mocks.video = {
			ownerId: "owner",
			metadata: { linkPreview: { version: 1, image: existingImage } },
		};
		await saveLinkPreview(form({ title: "New title" }));
		expect(sqlText(mocks.conditions[0])).toContain(
			`'$.linkPreview.image.key')), '') = ${existingImage.key}`,
		);
	});

	it("keeps an image another save swapped in instead of restoring the stale one", async () => {
		const swapped = { ...existingImage, key: "link-previews/video123/new.jpg" };
		mocks.video = {
			ownerId: "owner",
			metadata: { linkPreview: { version: 1, image: existingImage } },
		};
		mocks.rereads = [{ linkPreview: { version: 1, image: swapped } }];
		mocks.affected = [0, 1];

		const result = await saveLinkPreview(form({ title: "Text only" }));

		expect(result.success).toBe(true);
		expect(mocks.updates).toHaveLength(2);
		expect(storedJson()).toMatchObject({ title: "Text only", image: swapped });
		// The other request owns the old image's deletion; this one deletes nothing.
		expect(mocks.deletes).toHaveLength(0);
	});

	it("does not delete anything when a reset landed between the read and the write", async () => {
		mocks.video = {
			ownerId: "owner",
			metadata: { linkPreview: { version: 1, image: existingImage } },
		};
		mocks.rereads = [null];
		mocks.affected = [0, 1];

		const result = await saveLinkPreview(
			form({
				image: new File([jpeg(1200, 630)], "x.jpg", { type: "image/jpeg" }),
			}),
		);

		expect(result.success).toBe(true);
		expect(storedJson()?.image?.key).toBe(mocks.puts[0]?.key);
		expect(mocks.deletes).toHaveLength(0);
	});

	it("gives up after repeated conflicts and removes its own upload", async () => {
		mocks.video = { ownerId: "owner", metadata: null };
		mocks.affected = [0, 0, 0];
		await expect(
			saveLinkPreview(
				form({
					image: new File([jpeg(1200, 630)], "x.jpg", { type: "image/jpeg" }),
				}),
			),
		).rejects.toThrow("changed while saving");
		expect(mocks.updates).toHaveLength(3);
		expect(mocks.deletes).toEqual([mocks.puts[0]?.key]);
	});

	it("gives every upload its own object", async () => {
		await saveLinkPreview(
			form({
				image: new File([jpeg(1200, 630)], "a.jpg", { type: "image/jpeg" }),
			}),
		);
		await saveLinkPreview(
			form({
				image: new File([jpeg(1200, 630)], "a.jpg", { type: "image/jpeg" }),
			}),
		);
		expect(mocks.puts[0]?.key).not.toBe(mocks.puts[1]?.key);
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
		mocks.rereads = [];
		mocks.affected = [];
		mocks.conditions = [];
		mocks.selects = 0;
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

	it("does not write when there is nothing to reset", async () => {
		mocks.user = { id: "owner", stripeSubscriptionStatus: "active" };
		mocks.video = { ownerId: "owner", metadata: null };
		await resetLinkPreview(videoId as never);
		expect(mocks.updates).toHaveLength(0);
	});

	it("never deletes another video's image a duplicate carried over", async () => {
		mocks.user = { id: "owner", stripeSubscriptionStatus: "active" };
		const foreign = { ...existingImage, key: "link-previews/original/abc.jpg" };
		mocks.video = {
			ownerId: "owner",
			metadata: { linkPreview: { version: 1, title: "Copy", image: foreign } },
		};
		await resetLinkPreview(videoId as never);
		expect(sqlText(mocks.conditions[0])).toContain(foreign.key);
		expect(mocks.deletes).toHaveLength(0);
	});

	it("is owner only", async () => {
		mocks.user = { id: "someone-else", stripeSubscriptionStatus: "active" };
		await expect(resetLinkPreview(videoId as never)).rejects.toThrow(
			"permission",
		);
		expect(mocks.updates).toHaveLength(0);
	});
});
