import { Context, Effect } from "effect";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock("@cap/database", () => ({ db: () => ({ select: mocks.select }) }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => null,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
}));
vi.mock("@cap/ui", () => ({ Logo: () => null }));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/web-backend", () => ({
	VideosPolicy: Context.GenericTag("EmbedTestPolicy"),
	provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
	resolveEffectiveVideoRules: () => ({ settings: {} }),
}));
vi.mock("@/lib/server", () => ({
	runPromise: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		effect.pipe(
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
) {
	const video = {
		id: "video",
		ownerId: "owner",
		settings:
			videoSpeed === undefined ? null : { defaultPlaybackSpeed: videoSpeed },
		orgSettings:
			orgSpeed === undefined ? null : { defaultPlaybackSpeed: orgSpeed },
		transcriptionStatus: "COMPLETE",
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
	)) as ReactElement<{ defaultPlaybackSpeed?: number; minimal: boolean }>;
}

describe("embed default playback speed", () => {
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
