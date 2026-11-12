import { createHash, generateKeyPairSync } from "node:crypto";
import type { ImageUpload } from "@cap/web-domain";
import { Context, Effect } from "effect";
import type { ComponentProps, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Caps } from "@/app/(org)/dashboard/caps/Caps";
import CapsPage from "@/app/(org)/dashboard/caps/page";
import { createCloudFrontSignedUrl } from "../../../../packages/web-backend/src/S3Buckets/cloudfront-signed-url";

const mocks = vi.hoisted(() => ({ query: vi.fn(), resolveImage: vi.fn() }));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	return { db: () => drizzle(mocks.query) };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner", activeOrganizationId: "org-1" }),
}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", async () => {
	const { resolveEffectiveVideoRules } = await import(
		"../../../../packages/web-backend/src/Videos/EffectiveVideoRules"
	);
	return {
		Database: Context.GenericTag("CapsImagesDatabase"),
		ImageUploads: Context.GenericTag("CapsImages"),
		resolveEffectiveVideoRules,
	};
});
vi.mock("@/lib/server", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return {
		runPromise: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
			effect.pipe(
				Effect.provideService(Context.GenericTag("CapsImagesDatabase"), {
					use: <T>(callback: (db: typeof client) => Promise<T>) =>
						Effect.promise(() => callback(client)),
				}),
				Effect.provideService(Context.GenericTag("CapsImages"), {
					resolveImageUrl: (key: ImageUpload.ImageUrlOrKey) =>
						Effect.promise(() => mocks.resolveImage(key)),
				}),
				Effect.runPromise,
			),
	};
});
vi.mock("@/lib/seeded-thumbnails", () => ({
	seedThumbnailUrls: () => undefined,
}));
vi.mock("@/app/(org)/dashboard/caps/Caps", () => ({ Caps: () => null }));

const PAGE_SIZE = 15;
const COMMENTS_PER_CAP = 10;
const orgIcon = "organizations/org-1/icon.png";
const spaceIcon = "spaces/space-1/icon.png";
const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
let expiresAt = 2_000_000_000;
let iconsEnabled = true;

function signedUrl(key: string) {
	return createCloudFrontSignedUrl({
		bucketUrl: "https://cdn.example.test",
		key,
		keyPairId: "test-key",
		privateKey,
		expiresAt,
	});
}

function rowsFor(query: string) {
	if (query.startsWith("select count(")) return [[PAGE_SIZE]];
	if (query.includes(" group by ")) {
		return Array.from({ length: PAGE_SIZE }, (_, index) => [
			`video-${index}`,
			"owner",
			"Ten minute walkthrough",
			"2026-10-20 12:00:00",
			null,
			{ type: "desktopMP4" },
			false,
			600,
			true,
			COMMENTS_PER_CAP,
			0,
			Array.from({ length: COMMENTS_PER_CAP }, () => ({
				id: "org-1",
				name: "Team",
				iconUrl: iconsEnabled ? orgIcon : null,
			})),
			"Owner",
			"2026-10-20 12:00:00",
			false,
			false,
			null,
		]);
	}
	if (query.includes("from `space_videos`")) {
		return Array.from({ length: PAGE_SIZE }, (_, index) => [
			`video-${index}`,
			"space-1",
			"Private team space",
			"org-1",
			iconsEnabled ? spaceIcon : null,
			{ disableComments: true },
			true,
		]);
	}
	if (query.includes("from `shared_videos`")) {
		return Array.from({ length: PAGE_SIZE }, (_, index) => [
			`video-${index}`,
			"org-1",
			"Team",
			"org-1",
			iconsEnabled ? orgIcon : null,
		]);
	}
	return [];
}

async function loadPage() {
	return (await CapsPage({
		params: Promise.resolve({}),
		searchParams: Promise.resolve({}),
	})) as ReactElement<ComponentProps<typeof Caps>>;
}

beforeEach(() => {
	expiresAt = 2_000_000_000;
	iconsEnabled = true;
	mocks.query.mockReset().mockImplementation(async (query: string) => ({
		rows: rowsFor(query),
	}));
	mocks.resolveImage
		.mockReset()
		.mockImplementation(async (key: string) => signedUrl(key));
});

describe("Caps page icon resolution", () => {
	it("resolves each icon once while preserving caps and inherited sharing rules", async () => {
		const { props } = await loadPage();
		const resolvedOrgIcon = signedUrl(orgIcon);
		const resolvedSpaceIcon = signedUrl(spaceIcon);
		expect(props.data).toHaveLength(PAGE_SIZE);
		for (const cap of props.data) {
			expect(cap).toMatchObject({
				totalComments: COMMENTS_PER_CAP,
				duration: 600,
				inheritedSpaceSettings: {
					disableComments: [{ id: "space-1", name: "Private team space" }],
				},
				hasInheritedPassword: true,
			});
			expect(cap.sharedOrganizations).toHaveLength(COMMENTS_PER_CAP);
			expect(
				cap.sharedOrganizations.every((org) => org.iconUrl === resolvedOrgIcon),
			).toBe(true);
			expect(cap.sharedSpaces?.map((space) => space.iconUrl)).toEqual([
				resolvedSpaceIcon,
				resolvedOrgIcon,
			]);
		}
		expect(mocks.resolveImage.mock.calls.map(([key]) => key)).toEqual([
			orgIcon,
			spaceIcon,
		]);
	});

	it("resolves fresh URLs for the next page request", async () => {
		const first = await loadPage();
		expiresAt += 3600;
		const second = await loadPage();
		expect(second.props.data[0]?.sharedOrganizations[0]?.iconUrl).not.toBe(
			first.props.data[0]?.sharedOrganizations[0]?.iconUrl,
		);
		expect(mocks.resolveImage).toHaveBeenCalledTimes(4);
	});

	it("leaves missing icons null", async () => {
		iconsEnabled = false;
		const { props } = await loadPage();
		expect(props.data[0]?.sharedOrganizations[0]?.iconUrl).toBeNull();
		expect(mocks.resolveImage).not.toHaveBeenCalled();
	});

	it("propagates image resolution failures", async () => {
		mocks.resolveImage.mockRejectedValue(new Error("Signing unavailable"));
		await expect(loadPage()).rejects.toThrow("Signing unavailable");
	});

	it.skipIf(!process.env.CAP_CAPS_IMAGES_BENCH)(
		"measures page rendering with real RSA signing for 15 caps with 10 comments each",
		async () => {
			const samples: number[] = [];
			const outputs = new Set<string>();
			for (let iteration = 0; iteration < 22; iteration++) {
				const start = performance.now();
				const { props } = await loadPage();
				if (iteration > 0) samples.push(performance.now() - start);
				outputs.add(
					createHash("sha256").update(JSON.stringify(props)).digest("hex"),
				);
			}
			samples.sort((a, b) => a - b);
			expect(outputs.size).toBe(1);
			console.log(
				JSON.stringify({
					medianMs: samples[10],
					signaturesPerPage: mocks.resolveImage.mock.calls.length / 22,
				}),
			);
		},
	);
});
