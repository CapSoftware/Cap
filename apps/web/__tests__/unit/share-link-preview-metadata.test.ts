import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	organization: null as {
		customDomain: string | null;
		domainVerified: Date | null;
	} | null,
	owner: null as { stripeSubscriptionStatus: string | null } | null,
	access: null as {
		public: boolean;
		hasPassword: boolean;
		allowedEmailDomain: string | null;
	} | null,
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: true, NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	NODE_ENV: "production",
}));

vi.mock("@/lib/video-shared-spaces", () => ({
	getSharedSpacesForVideo: async () => ({
		sharedSpaces: [],
		sharedOrganizations: [],
	}),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: Record<symbol, unknown>) => {
				const rows = async () => {
					const name = table[Symbol.for("drizzle:Name")];
					const row =
						name === "users"
							? mocks.owner
							: name === "videos"
								? mocks.access
								: mocks.organization;
					return row ? [row] : [];
				};
				const chain = {
					leftJoin: () => chain,
					where: () => chain,
					limit: rows,
				};
				return chain;
			},
		}),
	}),
}));

import type { Organisation, User, Video } from "@cap/web-domain";
import { getShareLinkPreviewMetadata } from "@/lib/share-link-preview-metadata";
import { buildShareVideoMetadata } from "@/lib/share-video-metadata";

const organizationId = "org123" as Organisation.OrganisationId;
const image = {
	key: "link-previews/video123/kx1.jpg",
	width: 1200,
	height: 630,
	contentType: "image/jpeg",
	size: 2048,
};

const build = async (metadata: unknown, webUrl = "https://cap.so") => {
	const { linkPreview, canonicalShareUrl } = await getShareLinkPreviewMetadata({
		videoId: "video123" as Video.VideoId,
		ownerId: "owner123" as User.UserId,
		organizationId,
		metadata,
		webUrl,
	});
	return buildShareVideoMetadata({
		videoId: "video123",
		name: "Product demo",
		sourceType: "desktopMP4",
		webUrl,
		canonicalWebUrl: "https://cap.so",
		linkPreview,
		canonicalShareUrl,
	});
};

describe("share metadata with link preview overrides", () => {
	beforeEach(() => {
		mocks.organization = null;
		mocks.owner = { stripeSubscriptionStatus: "active" };
		mocks.access = {
			public: true,
			hasPassword: false,
			allowedEmailDomain: null,
		};
	});

	it("keeps the dynamic defaults when nothing is set", async () => {
		const metadata = await build({});
		expect(metadata.title).toBe("Product demo | Cap Recording");
		expect(metadata.description).toBe("Watch this video on Cap");
		expect(metadata.openGraph).toMatchObject({
			title: "Product demo | Cap Recording",
			url: "https://cap.so/s/video123",
		});
		const images = (metadata.openGraph as { images: { url: string }[] }).images;
		expect(images.map((entry) => entry.url)).toEqual([
			"https://cap.so/api/video/preview?videoId=video123&fallback=og",
			"https://cap.so/api/video/og?videoId=video123",
		]);
		expect(metadata.alternates?.canonical).toBe("https://cap.so/s/video123");
	});

	it("uses the owner's title, description and image everywhere", async () => {
		const metadata = await build({
			linkPreview: {
				version: 1,
				title: "Q3 launch walkthrough",
				description: "Five minutes on what shipped.",
				image,
				updatedAt: "2026-10-05T00:00:00.000Z",
			},
		});
		const imageUrl = expect.stringMatching(
			/^https:\/\/cap\.so\/api\/video\/link-preview\?videoId=video123&v=kx1-[0-9a-z]+$/,
		);
		expect(metadata.title).toBe("Q3 launch walkthrough");
		expect(metadata.description).toBe("Five minutes on what shipped.");
		expect(metadata.openGraph).toMatchObject({
			title: "Q3 launch walkthrough",
			description: "Five minutes on what shipped.",
			images: [{ url: imageUrl, width: 1200, height: 630, type: "image/jpeg" }],
		});
		expect(metadata.twitter).toMatchObject({
			title: "Q3 launch walkthrough",
			description: "Five minutes on what shipped.",
			images: [imageUrl],
		});
		// The video stays attached so players still unfurl.
		expect((metadata.openGraph as { videos: unknown[] }).videos).toHaveLength(
			1,
		);
	});

	it.each([null, "canceled"])(
		"pauses the overrides while the owner has no Pro plan (%s)",
		async (stripeSubscriptionStatus) => {
			mocks.owner = { stripeSubscriptionStatus };
			const metadata = await build({
				linkPreview: { version: 1, title: "Kept for later", image },
			});
			expect(metadata.title).toBe("Product demo | Cap Recording");
			expect(
				(metadata.openGraph as { images: { url: string }[] }).images[1]?.url,
			).toBe("https://cap.so/api/video/og?videoId=video123");
		},
	);

	it("only replaces the parts the owner set", async () => {
		const metadata = await build({
			linkPreview: { version: 1, description: "Just the description" },
		});
		expect(metadata.title).toBe("Product demo | Cap Recording");
		expect(metadata.description).toBe("Just the description");
		expect((metadata.openGraph as { images: unknown[] }).images).toHaveLength(
			2,
		);
	});

	it("serves the image from the host the link was opened on", async () => {
		const metadata = await build(
			{ linkPreview: { version: 1, image } },
			"https://videos.example.com",
		);
		expect(metadata.twitter).toMatchObject({
			images: [
				expect.stringMatching(
					/^https:\/\/videos\.example\.com\/api\/video\/link-preview\?videoId=video123&v=kx1-/,
				),
			],
		});
	});

	it("moves the image to a new URL when the video goes private", async () => {
		const imageUrl = async () =>
			(
				(await build({ linkPreview: { version: 1, image } })).twitter as {
					images: string[];
				}
			).images[0];
		const before = await imageUrl();
		mocks.access = {
			public: false,
			hasPassword: false,
			allowedEmailDomain: null,
		};
		const after = await imageUrl();
		expect(after).toMatch(/v=kx1-/);
		expect(after).not.toBe(before);
	});

	it("points the canonical URL at a verified custom domain", async () => {
		mocks.organization = {
			customDomain: "Videos.Example.com",
			domainVerified: new Date(),
		};
		const metadata = await build({});
		expect(metadata.alternates?.canonical).toBe(
			"https://videos.example.com/s/video123",
		);
		// og:url follows the visited host: Slack drops the image otherwise.
		expect(metadata.openGraph).toMatchObject({
			url: "https://cap.so/s/video123",
		});
	});

	it("ignores an unverified custom domain", async () => {
		mocks.organization = {
			customDomain: "videos.example.com",
			domainVerified: null,
		};
		const metadata = await build({});
		expect(metadata.alternates?.canonical).toBe("https://cap.so/s/video123");
	});
});
