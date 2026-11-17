import { Context, Effect } from "effect";
import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn(), ownerIsPro: true }));

vi.mock("@cap/database", () => ({ db: () => ({ select: mocks.select }) }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => null,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
}));
vi.mock("@cap/ui", () => ({ Logo: () => null }));
vi.mock("@cap/utils", () => ({ userIsPro: () => mocks.ownerIsPro }));
vi.mock("@cap/web-backend", () => ({
	ImageUploads: Context.GenericTag("EmbedTestImages"),
	VideosPolicy: Context.GenericTag("EmbedTestPolicy"),
	provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
	resolveEffectiveVideoRules: () => ({ settings: {} }),
}));
vi.mock("@/lib/server", () => ({
	runPromise: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		effect.pipe(
			Effect.provideService(Context.GenericTag("EmbedTestImages"), {
				resolveImageUrl: (url: string) => Effect.succeed(url),
			}),
			Effect.provideService(Context.GenericTag("EmbedTestPolicy"), {
				canView: () => Effect.void,
			}),
			Effect.runPromise,
		),
}));
vi.mock("@/lib/shareable-link-quota", () => ({
	isVideoOverShareableLinkLimit: async () => false,
}));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: async () => false }));
vi.mock("@/app/embed/[videoId]/_components/PasswordOverlay", () => ({
	PasswordOverlay: () => null,
}));
vi.mock("@/app/embed/[videoId]/_components/EmbedVideo", () => ({
	EmbedVideo: () => null,
}));

import EmbedVideoPage from "@/app/embed/[videoId]/page";

async function renderEmbed(
	videoSpeed: number | undefined,
	orgSpeed: number | undefined,
	minimal = false,
	overrides: Record<string, unknown> = {},
) {
	const video = {
		id: "video",
		ownerId: "owner",
		settings: {
			defaultPlaybackSpeed: videoSpeed,
			callToAction: { label: "Book a call", url: "https://example.com/" },
		},
		orgSettings:
			orgSpeed === undefined ? null : { defaultPlaybackSpeed: orgSpeed },
		transcriptionStatus: "COMPLETE",
		...overrides,
	};
	mocks.select.mockImplementation((selection: Record<string, unknown>) => {
		const rows =
			"ownerId" in selection
				? [video]
				: "email" in selection
					? [{ email: "owner@example.com" }]
					: [];
		const query = {
			from: () => query,
			leftJoin: () => query,
			innerJoin: () => query,
			where: () => Object.assign(Promise.resolve(rows), { limit: () => rows }),
		};
		return query;
	});

	const page = (await EmbedVideoPage({
		params: Promise.resolve({ videoId: "video" }),
		searchParams: Promise.resolve(minimal ? { slack: "true" } : {}),
	})) as ReactElement<{ children: unknown[] }>;
	const content = page.props.children[1];
	if (!isValidElement(content) || typeof content.type !== "function") {
		throw new Error("Expected authorized embed content");
	}
	return (await (content.type as (props: unknown) => Promise<unknown>)(
		content.props,
	)) as ReactElement<{
		defaultPlaybackSpeed?: number;
		minimal: boolean;
		callToAction: { label: string; url: string } | null;
		data: Record<string, unknown>;
	}>;
}

describe("embed default playback speed", () => {
	beforeEach(() => {
		mocks.ownerIsPro = true;
	});

	it.each([
		{ ownerIsPro: false, minimal: false },
		{ ownerIsPro: true, minimal: false },
		{ ownerIsPro: true, minimal: true },
	])("gates saved calls to action: %j", async ({ ownerIsPro, minimal }) => {
		mocks.ownerIsPro = ownerIsPro;
		const embed = await renderEmbed(undefined, undefined, minimal);
		if (ownerIsPro && !minimal) {
			expect(embed.props.callToAction).toMatchObject({
				label: "Book a call",
				url: "https://example.com/",
			});
		} else {
			expect(embed.props.callToAction).toBeNull();
		}
	});

	it("serves the workspace default on a newer video without exposing it", async () => {
		const embed = await renderEmbed(undefined, undefined, false, {
			settings: {},
			createdAt: new Date("2026-10-02T00:00:00.000Z"),
			orgSettings: {
				disableComments: true,
				defaultCallToAction: {
					label: "Talk to sales",
					url: "https://example.com/sales",
					enabledAt: "2026-10-01T00:00:00.000Z",
				},
			},
		});
		expect(embed.props.callToAction).toMatchObject({ label: "Talk to sales" });
		expect(embed.props.data).not.toHaveProperty("orgSettings");
	});

	it("keeps the workspace default off older videos", async () => {
		const embed = await renderEmbed(undefined, undefined, false, {
			settings: {},
			createdAt: new Date("2026-09-01T00:00:00.000Z"),
			orgSettings: {
				defaultCallToAction: {
					label: "Talk to sales",
					url: "https://example.com/sales",
					enabledAt: "2026-10-01T00:00:00.000Z",
				},
			},
		});
		expect(embed.props.callToAction).toBeNull();
	});

	it.each([
		{ name: "organization 1×", video: undefined, org: 1, expected: 1 },
		{ name: "video override", video: 1.5, org: 1, expected: 1.5 },
		{ name: "video 1× override", video: 1, org: 1.5, expected: 1 },
		{ name: "no settings", video: undefined, org: undefined, expected: 1.2 },
		{ name: "invalid video speed", video: 0, org: 1, expected: 1 },
		{ name: "invalid speeds", video: -1, org: 0, expected: 1.2 },
		{ name: "legacy speed normalization", video: 1.3, org: 1, expected: 1.2 },
	])("resolves $name", async ({ video, org, expected }) => {
		const embed = await renderEmbed(video, org);
		expect(embed.props.defaultPlaybackSpeed).toBe(expected);
	});

	it("uses the organization speed for minimal embeds", async () => {
		const embed = await renderEmbed(undefined, 1, true);
		expect(embed.props.minimal).toBe(true);
		expect(embed.props.defaultPlaybackSpeed).toBe(1);
	});
});
