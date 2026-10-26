import { createHash } from "node:crypto";
import { Policy, Video } from "@cap/web-domain";
import { Context, Effect } from "effect";
import type { ComponentProps, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	canView: vi.fn(),
	transcribe: vi.fn(),
	resolveImage: vi.fn(),
	getCurrentUser: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/ui", () => ({ Logo: () => null }));
vi.mock("@cap/utils", () => ({
	userIsPro: (user: { stripeSubscriptionStatus: string | null }) =>
		user.stripeSubscriptionStatus === "active",
}));
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	const { resolveEffectiveVideoRules } = await import(
		"../../../../packages/web-backend/src/Videos/EffectiveVideoRules"
	);
	return {
		ImageUploads: Context.GenericTag("EmbedPerfImages"),
		VideosPolicy: Context.GenericTag("EmbedPerfPolicy"),
		provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
		resolveEffectiveVideoRules,
	};
});
vi.mock("@/lib/server", () => ({
	runPromise: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		effect.pipe(
			Effect.provideService(Context.GenericTag("EmbedPerfPolicy"), {
				canView: mocks.canView,
			}),
			Effect.provideService(Context.GenericTag("EmbedPerfImages"), {
				resolveImageUrl: (url: string) =>
					Effect.promise(() => mocks.resolveImage(url)),
			}),
			Effect.runPromise,
		),
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
}));
vi.mock("@/lib/loom-deferred-processing", () => ({
	getPendingLoomProcessing: () => null,
}));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: mocks.transcribe }));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: async () => true }));
vi.mock("@/app/embed/[videoId]/_components/EmbedVideo", () => ({
	EmbedVideo: () => null,
}));
vi.mock("@/app/embed/[videoId]/_components/PasswordOverlay", () => ({
	PasswordOverlay: () => null,
}));

import type { EmbedVideo } from "@/app/embed/[videoId]/_components/EmbedVideo";
import EmbedVideoPage from "@/app/embed/[videoId]/page";

const createdAt = "2026-10-20 12:00:00";
const recording = {
	id: "video-1",
	name: "Ten minute walkthrough",
	ownerId: "owner",
	orgId: "org-1",
	createdAt,
	updatedAt: createdAt,
	effectiveCreatedAt: createdAt,
	source: { type: "desktopMP4" },
	metadata: { chapters: [{ title: "Introduction", start: 0 }] },
	settings: { defaultPlaybackSpeed: 1.5 },
	duration: 600,
	public: 1,
	isScreenshot: 0,
	transcriptionStatus: "COMPLETE",
};
const owner = {
	email: "owner@example.com",
	stripeSubscriptionStatus: "active",
	thirdPartyStripeSubscriptionId: null,
	name: "Owner",
	image: "avatars/owner.png",
};
let videoData: Record<string, unknown>;
let ownerData: Record<string, unknown> | null;
let earlierVideos: number;
let noComments: boolean;
let disableChapters: boolean;

function project(
	query: string,
	tables: Record<string, Record<string, unknown>>,
) {
	return query
		.slice(7, query.indexOf(" from "))
		.split(", ")
		.map((column) => {
			if (column.includes(" IS NOT NULL")) return 0;
			const match = /^`(?:(\w+)`\.)?`?(\w+)`$/.exec(column);
			if (!match) throw new Error(`Unexpected projection: ${column}`);
			const table = match[1] ? tables[match[1]] : Object.values(tables)[0];
			return table?.[match[2] ?? ""] ?? null;
		});
}

function rowsFor(query: string) {
	if (query.startsWith("select count(")) return [[earlierVideos]];
	if (query.includes("from `videos`")) {
		return [
			project(query, {
				videos: videoData,
				organizations: {
					name: "Team",
					settings: { shareableLinkUseOrganizationIcon: true },
					iconUrl: "organizations/team.png",
				},
				shared_videos: { organizationId: "shared-org" },
			}),
		];
	}
	if (query.includes("from `users`"))
		return ownerData ? [project(query, { users: ownerData })] : [];
	if (query.includes("from `space_videos`"))
		return [["space-1", "Project", { disableChapters }, 0]];
	if (query.includes("from `comments`"))
		return noComments
			? []
			: Array.from({ length: 30 }, (_, index) =>
					project(query, {
						comments: {
							id: `comment-${index}`,
							videoId: recording.id,
							authorId: `author-${index % 5}`,
							content: `Review note ${index}`,
							type: "text",
							timestamp: index * 20,
							createdAt,
							updatedAt: createdAt,
						},
						users: { name: `Reviewer ${index % 5}` },
					}),
				);
	throw new Error(`Unexpected query: ${query}`);
}

async function loadContent(searchParams: Record<string, string> = {}) {
	const page = (await EmbedVideoPage({
		params: Promise.resolve({ videoId: recording.id }),
		searchParams: Promise.resolve(searchParams),
	})) as ReactElement<{ children: [ReactElement, ReactElement | false] }>;
	const content = page.props.children[1];
	if (!content || typeof content.type !== "function")
		throw new Error("Expected embed content");
	const renderContent = content.type as (
		props: unknown,
	) => Promise<ReactElement<ComponentProps<typeof EmbedVideo>>>;
	return renderContent(content.props);
}

beforeEach(() => {
	videoData = { ...recording };
	ownerData = { ...owner };
	earlierVideos = 0;
	noComments = false;
	disableChapters = false;
	mocks.query.mockReset().mockImplementation(async (query: string) => ({
		rows: rowsFor(query),
	}));
	mocks.canView.mockReturnValue(Effect.void);
	mocks.resolveImage.mockReset().mockImplementation(async (key: string) => key);
	mocks.getCurrentUser.mockReset().mockResolvedValue({ id: "viewer" });
});

describe("embed page server load", () => {
	it("keeps player props, settings, comments and owner branding", async () => {
		const { props } = await loadContent({ autoplay: "true", t: "83" });
		expect(props).toMatchObject({
			data: { id: "video-1", duration: 600 },
			user: { id: "viewer" },
			ownerName: "Owner",
			ownerImageUrl: "avatars/owner.png",
			branding: {
				type: "custom",
				name: "Team",
				imageUrl: "organizations/team.png",
			},
			chapters: [{ title: "Introduction", start: 0 }],
			defaultPlaybackSpeed: 1.5,
			autoplay: true,
			startTime: 83,
			minimal: false,
			showPlaybackStatusBadge: false,
		});
		expect(props.comments).toHaveLength(30);
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("keeps anonymous, minimal and inherited settings behavior", async () => {
		mocks.getCurrentUser.mockResolvedValue(null);
		disableChapters = true;
		const { props } = await loadContent({ slack: "true" });
		expect(props).toMatchObject({
			user: null,
			minimal: true,
			chapters: [],
			branding: { type: "cap" },
			viewerSettings: { disableChapters: true },
		});
		expect(mocks.resolveImage).toHaveBeenCalledTimes(1);
	});

	it("keeps missing owners and empty comments viewable", async () => {
		ownerData = null;
		noComments = true;
		const { props } = await loadContent();
		expect(props).toMatchObject({
			ownerName: null,
			ownerImageUrl: null,
			branding: { type: "cap" },
			comments: [],
		});
		expect(mocks.resolveImage).not.toHaveBeenCalled();
	});

	it("keeps quota failures viewable", async () => {
		ownerData = { ...owner, stripeSubscriptionStatus: null };
		const error = new Error("quota unavailable");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.query.mockImplementation(async (query: string) => {
			if (query.startsWith("select count(")) throw error;
			return { rows: rowsFor(query) };
		});
		expect((await loadContent()).props.comments).toHaveLength(30);
		expect(log).toHaveBeenCalledWith(
			"[EmbedVideoPage] Shareable link quota check failed for video-1:",
			expect.any(Error),
		);
	});

	it("propagates image failures", async () => {
		mocks.resolveImage.mockRejectedValue(new Error("image unavailable"));
		await expect(loadContent()).rejects.toThrow("image unavailable");
	});

	it.each([false, true])(
		"does not load comments or images for blocked content, screenshot=%s",
		async (screenshot) => {
			ownerData = { ...owner, stripeSubscriptionStatus: null };
			videoData = { ...recording, isScreenshot: Number(screenshot) };
			earlierVideos = 25;
			const result = await loadContent();
			expect(renderToStaticMarkup(result)).toContain(
				screenshot ? "Screenshots cannot be embedded" : "over its free limit",
			);
			expect(
				mocks.query.mock.calls.some(([query]) =>
					query.includes("from `comments`"),
				),
			).toBe(false);
			expect(mocks.resolveImage).not.toHaveBeenCalled();
		},
	);

	it.each([
		new Policy.PolicyDeniedError(),
		new Video.VerifyVideoPasswordError({
			id: Video.VideoId.make("video-1"),
			cause: "not-provided",
		}),
	])("does not load content before authorization succeeds", async (error) => {
		mocks.canView.mockReturnValue(Effect.fail(error));
		await EmbedVideoPage({
			params: Promise.resolve({ videoId: recording.id }),
			searchParams: Promise.resolve({}),
		});
		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.getCurrentUser).not.toHaveBeenCalled();
	});

	it.each([
		{ pro: true, expectedRounds: 3, expectedQueries: 4 },
		{ pro: false, expectedRounds: 4, expectedQueries: 5 },
	])(
		"bounds database rounds with one owner read, Pro=$pro",
		async ({ pro, expectedRounds, expectedQueries }) => {
			ownerData = { ...owner, stripeSubscriptionStatus: pro ? "active" : null };
			const pending: Array<() => void> = [];
			mocks.query.mockImplementation(
				(query: string) =>
					new Promise((resolve) => {
						pending.push(() => resolve({ rows: rowsFor(query) }));
					}),
			);
			let settled = false;
			const page = loadContent().finally(() => {
				settled = true;
			});
			let roundTrips = 0;
			let idleTicks = 0;
			for (let tick = 0; tick < 200 && !settled; tick++) {
				const issued = mocks.query.mock.calls.length;
				await new Promise((resolve) => setTimeout(resolve, 0));
				if (mocks.query.mock.calls.length !== issued || pending.length === 0) {
					idleTicks = 0;
					continue;
				}
				if (++idleTicks < 3) continue;
				idleTicks = 0;
				roundTrips++;
				for (const release of pending.splice(0)) release();
			}
			expect(settled).toBe(true);
			expect((await page).props.comments).toHaveLength(30);
			expect({ roundTrips, queries: mocks.query.mock.calls.length }).toEqual({
				roundTrips: expectedRounds,
				queries: expectedQueries,
			});
		},
	);

	it.skipIf(!process.env.CAP_EMBED_PAGE_BENCH).each([
		{ pro: true, imageLatencyMs: 0 },
		{ pro: true, imageLatencyMs: 20 },
		{ pro: false, imageLatencyMs: 0 },
		{ pro: false, imageLatencyMs: 20 },
	])(
		"measures simulated 20ms database latency, Pro=$pro, image latency=$imageLatencyMs",
		async ({ pro, imageLatencyMs }) => {
			ownerData = { ...owner, stripeSubscriptionStatus: pro ? "active" : null };
			mocks.query.mockImplementation(async (query: string) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { rows: rowsFor(query) };
			});
			mocks.resolveImage.mockImplementation(async (key: string) => {
				if (imageLatencyMs)
					await new Promise((resolve) => setTimeout(resolve, imageLatencyMs));
				return key;
			});
			const samples: number[] = [];
			const outputs = new Set<string>();
			for (let iteration = 0; iteration < 22; iteration++) {
				const start = performance.now();
				const result = await loadContent();
				if (iteration > 0) samples.push(performance.now() - start);
				outputs.add(
					createHash("sha256")
						.update(JSON.stringify(result.props))
						.digest("hex"),
				);
			}
			samples.sort((a, b) => a - b);
			expect(outputs.size).toBe(1);
			console.log(
				JSON.stringify({
					pro,
					imageLatencyMs,
					medianMs: samples[10],
					queriesPerLoad: mocks.query.mock.calls.length / 22,
					output: [...outputs][0],
				}),
			);
		},
	);
});
