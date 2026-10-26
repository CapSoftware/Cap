import { createHash } from "node:crypto";
import { organizations } from "@cap/database/schema";
import { getTableColumns } from "drizzle-orm";
import { Context, Effect } from "effect";
import { type ComponentProps, isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "viewer", activeOrganizationId: "org-1" }),
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/ui", () => ({ Logo: () => null }));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/web-backend", async () => {
	const { Context, Effect } = await import("effect");
	const { resolveEffectiveVideoRules } = await import(
		"../../../../packages/web-backend/src/Videos/EffectiveVideoRules"
	);
	return {
		Database: Context.GenericTag("SharePerfDatabase"),
		ImageUploads: Context.GenericTag("SharePerfImages"),
		Videos: Context.GenericTag("SharePerfVideos"),
		Tinybird: Context.GenericTag("SharePerfAnalytics"),
		provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
		resolveEffectiveVideoRules,
	};
});
vi.mock("@cap/web-backend/src/Videos/VideosPolicy", () => ({
	VideosPolicy: Context.GenericTag("SharePerfPolicy"),
}));
vi.mock("@/lib/server", async () => {
	const { db } = await import("@cap/database");
	return {
		runPromise: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
			effect.pipe(
				Effect.provideService(Context.GenericTag("SharePerfPolicy"), {
					canViewLoaded: () => Effect.void,
				}),
				Effect.provideService(Context.GenericTag("SharePerfDatabase"), {
					use: <T>(callback: (client: ReturnType<typeof db>) => Promise<T>) =>
						Effect.promise(() => callback(db())),
				}),
				Effect.provideService(Context.GenericTag("SharePerfImages"), {
					resolveImageUrl: (url: string) => Effect.succeed(url),
				}),
				Effect.provideService(Context.GenericTag("SharePerfAnalytics"), {
					querySql: () => Effect.succeed({ data: [{ views: 120 }] }),
				}),
				Effect.runPromise,
			),
	};
});
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => false }));
vi.mock("@/lib/desktop-segments-recovery", () => ({
	completeDesktopSegmentsManifestAndQueue: vi.fn(),
}));
vi.mock("@/lib/Notification", () => ({
	createNotification: async () => undefined,
}));
vi.mock("@/lib/loom-deferred-processing", () => ({
	getPendingLoomProcessing: () => null,
}));
vi.mock("@/lib/public-share-video", () => ({ getPublicShareVideo: vi.fn() }));
vi.mock("@/lib/share-playback", () => ({
	canStartPlaybackInHtml: () => true,
	getSharePlaybackSource: async () => ({
		url: "https://media.example.com/result.mp4",
		defaultStorage: true,
	}),
}));
vi.mock("@/lib/share-web-url", () => ({ resolveShareWebUrl: vi.fn() }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: async () => true }));
vi.mock("@/app/s/[videoId]/_components/PasswordGate", () => ({
	PasswordGate: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/PendingRecordingShare", () => ({
	PendingRecordingShare: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/ShareHeader", () => ({
	ShareHeader: () => null,
}));
vi.mock("@/app/s/[videoId]/Share", () => ({ Share: () => null }));

import type { ShareHeader } from "@/app/s/[videoId]/_components/ShareHeader";
import ShareVideoPage from "@/app/s/[videoId]/page";
import type { Share } from "@/app/s/[videoId]/Share";

const createdAt = "2026-10-20 12:00:00";
const organization = {
	id: "org-1",
	name: "Team",
	ownerId: "viewer",
	settings: {},
};
const recording = {
	id: "video-1",
	name: "Ten minute walkthrough",
	ownerId: "owner",
	orgId: "org-1",
	createdAt,
	updatedAt: createdAt,
	effectiveCreatedAt: createdAt,
	source: { type: "desktopMP4" },
	metadata: { summary: "Project walkthrough" },
	duration: 600,
	public: 1,
	isScreenshot: 0,
	transcriptionStatus: "COMPLETE",
};

function project(
	query: string,
	tables: Record<string, Record<string, unknown>>,
) {
	return query
		.slice(7, query.indexOf(" from "))
		.split(", ")
		.map((column) => {
			if (column.includes(" IS NOT NULL")) return 0;
			const match = /^`(\w+)`\.`(\w+)`$/.exec(column);
			if (!match) throw new Error(`Unexpected projection: ${column}`);
			return tables[match[1] ?? ""]?.[match[2] ?? ""] ?? null;
		});
}

function rowsFor(query: string) {
	if (
		query.includes("from `videos` inner join") ||
		query.includes("from `videos` left join")
	) {
		return [
			project(query, {
				videos: recording,
				users: { id: "owner", name: "Owner", email: "owner@example.com" },
				organizations: organization,
				shared_videos: { organizationId: "shared-org" },
			}),
		];
	}
	if (query.includes("from `comments`")) {
		return Array.from({ length: 30 }, (_, index) =>
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
				users: {
					name: `Reviewer ${index % 5}`,
					image: "https://example.com/avatar.png",
				},
			}),
		);
	}
	if (query.includes("from `organizations`")) {
		if (query.includes("left join")) return [["viewer", "member"]];
		if (query.includes("inner join")) return [];
		if (query.startsWith("select `id`, `name` from"))
			return [["org-1", "Team"]];
		return [
			Object.values(getTableColumns(organizations)).map(
				(column) =>
					(organization as Record<string, unknown>)[column.name] ?? null,
			),
		];
	}
	if (query.includes("from `organization_members`")) {
		if (query.includes("count(")) return [[5]];
		if (query.startsWith("select `role`")) return [["member"]];
		return [];
	}
	if (query.includes("from `spaces`"))
		return Array.from({ length: 3 }, (_, i) => [
			`dashboard-space-${i}`,
			0,
			"Public",
			0,
			`Space ${i}`,
			null,
			"org-1",
			"viewer",
			null,
			{},
			"member",
			0,
			5,
			10,
		]);
	if (query.includes("from `videos`")) return [["org-1"]];
	if (query.includes("from `shared_videos`")) {
		if (query.includes("COUNT(")) return [[10]];
		if (query.includes("inner join `organization_members`")) return [];
		if (query.includes("inner join `organizations`"))
			return [["shared-org", "Shared team", "shared-org", null]];
		return [["shared-org"]];
	}
	if (query.includes("from `space_videos`")) {
		if (query.includes("inner join `space_members`"))
			return query.includes("inner join `spaces`")
				? [["space-1", "Project", "org-1"]]
				: [["space-member"]];
		if (query.includes("inner join `spaces`"))
			return [["space-1", "Project", "org-1", null, {}, 0]];
		return [["space-1"]];
	}
	if (query.includes("from `space_members`")) return [["space-member"]];
	if (query.includes("from `video_edits`")) return [];
	throw new Error(`Unexpected query: ${query}`);
}

async function loadPage() {
	const page = (await ShareVideoPage({
		params: Promise.resolve({ videoId: recording.id }),
		searchParams: Promise.resolve({}),
	})) as ReactElement<{ children: unknown }>;
	const authorized = page.props.children;
	if (!isValidElement(authorized) || typeof authorized.type !== "function") {
		throw new Error("Expected authorized content");
	}
	const content = await (
		authorized.type as (
			props: unknown,
		) => Promise<
			ReactElement<{ children: ReactElement<ComponentProps<typeof Share>> }>
		>
	)(authorized.props);
	const props = content.props.children.props;
	const { header, comments, views, initialPlaybackUrl, ...data } = props;
	const headerElement = header as ReactElement<
		ComponentProps<typeof ShareHeader>
	>;
	return {
		...data,
		header: { ...headerElement.props, views: await headerElement.props.views },
		comments: await comments,
		views: await views,
		initialPlaybackUrl: await initialPlaybackUrl,
	};
}

beforeEach(() => mocks.query.mockReset());

describe("share page database round trips", () => {
	it("keeps download permission and edit checks within the existing page load", async () => {
		const pending: Array<() => void> = [];
		mocks.query.mockImplementation(
			(query: string) =>
				new Promise((resolve) => {
					pending.push(() => resolve({ rows: rowsFor(query) }));
				}),
		);
		let settled = false;
		const page = loadPage().finally(() => {
			settled = true;
		});
		let roundTrips = 0;
		let idleTicks = 0;
		while (!settled) {
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
		const result = await page;
		expect(result.comments).toHaveLength(30);
		expect(result.data).toMatchObject({ duration: 600 });
		expect(result.header.spacesData).toHaveLength(4);
		expect(result.header).toMatchObject({ canDownload: true, hasEdits: false });
		expect({ roundTrips, queries: mocks.query.mock.calls.length }).toEqual({
			roundTrips: 4,
			queries: 20,
		});
	});

	it.skipIf(!process.env.CAP_SHARE_PAGE_BENCH)(
		"measures simulated 20ms database latency",
		async () => {
			const samples: number[] = [];
			const outputs = new Set<string>();
			mocks.query.mockImplementation(async (query: string) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { rows: rowsFor(query) };
			});
			for (let iteration = 0; iteration < 22; iteration++) {
				const start = performance.now();
				const result = await loadPage();
				if (iteration > 0) samples.push(performance.now() - start);
				outputs.add(
					createHash("sha256").update(JSON.stringify(result)).digest("hex"),
				);
			}
			samples.sort((a, b) => a - b);
			expect(outputs.size).toBe(1);
			console.log(
				JSON.stringify({
					medianMs: samples[10],
					queriesPerLoad: mocks.query.mock.calls.length / 22,
					output: [...outputs][0],
				}),
			);
		},
	);
});
