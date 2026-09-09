import { Context, Effect, Option } from "effect";
import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	select: vi.fn(),
	policy: vi.fn(),
	reconcile: vi.fn(),
	playbackUrl: vi.fn(),
	quota: vi.fn(),
	user: vi.fn(),
	sharedOrganizations: [] as {
		id: string;
		name: string;
		organizationId: string;
	}[],
}));

vi.mock("@cap/database", () => ({ db: () => ({ select: mocks.select }) }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/ui", () => ({ Logo: () => null }));
vi.mock("@cap/utils", () => ({ userIsPro: () => false }));
vi.mock("@cap/web-backend", () => ({
	Database: Context.GenericTag("ShareTestDatabase"),
	ImageUploads: Context.GenericTag("ShareTestImages"),
	Videos: Context.GenericTag("ShareTestVideos"),
	provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
	resolveEffectiveVideoRules: () => ({
		settings: {},
		hasInheritedPassword: false,
		inheritedPasswordSources: [],
		inheritedSettings: {},
	}),
}));
vi.mock("@cap/web-backend/src/Videos/VideosPolicy", () => ({
	VideosPolicy: Context.GenericTag("ShareTestPolicy"),
}));
vi.mock("@/lib/server", () => ({
	runPromise: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		effect.pipe(
			Effect.provideService(Context.GenericTag("ShareTestPolicy"), {
				canViewLoaded: mocks.policy,
			}),
			Effect.provideService(Context.GenericTag("ShareTestDatabase"), {
				use: () => Effect.succeed([]),
			}),
			Effect.provideService(Context.GenericTag("ShareTestImages"), {
				resolveImageUrl: (url: string) => Effect.succeed(url),
			}),
			Effect.provideService(Context.GenericTag("ShareTestVideos"), {
				getThumbnailURL: () =>
					Effect.succeed(Option.some("https://media.example.com/image.jpg")),
			}),
			Effect.runPromise,
		),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
}));
vi.mock("@/actions/videos/get-analytics", () => ({
	getVideoAnalytics: async () => ({ count: 12 }),
}));
vi.mock("@/app/(org)/dashboard/dashboard-data", () => ({
	getDashboardSpacesData: async () => [],
}));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => false }));
vi.mock("@/lib/desktop-segments-recovery", () => ({
	completeDesktopSegmentsManifestAndQueue: vi.fn(),
}));
vi.mock("@/lib/Notification", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/public-share-video", () => ({ getPublicShareVideo: vi.fn() }));
vi.mock("@/lib/share-playback", () => ({
	getSharePlaybackUrl: mocks.playbackUrl,
}));
vi.mock("@/lib/shareable-link-quota", () => ({
	isVideoOverShareableLinkLimit: mocks.quota,
}));
vi.mock("@/lib/share-web-url", () => ({ resolveShareWebUrl: vi.fn() }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/lib/video-download-permissions", () => ({
	canUserDownloadVideo: async () => false,
}));
vi.mock("@/lib/video-edit-processing", () => ({
	isEditSourceKey: ({ rawFileKey }: { rawFileKey: string | null }) =>
		rawFileKey === "owner/video/source/original.mp4",
	reconcileStaleEditUpload: mocks.reconcile,
}));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: async () => false }));
vi.mock("@/app/s/[videoId]/_components/PasswordOverlay", () => ({
	PasswordOverlay: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/PendingRecordingShare", () => ({
	PendingRecordingShare: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/ShareHeader", () => ({
	ShareHeader: () => null,
}));
vi.mock("@/app/s/[videoId]/Share", () => ({ Share: () => null }));

import ShareVideoPage from "@/app/s/[videoId]/page";

const createVideo = () => ({
	id: "video",
	name: "Recording",
	ownerId: "owner",
	owner: { id: "owner", image: null },
	orgId: "organization",
	public: true,
	password: null,
	source: { type: "desktopMP4" },
	isScreenshot: false,
	hasActiveUpload: false,
	activeUploadRawFileKey: null as string | null,
	organizationTombstoneAt: null as Date | null,
	metadata: null,
	transcriptionStatus: "COMPLETE",
	createdAt: new Date("2026-09-01T00:00:00.000Z"),
	updatedAt: new Date("2026-09-01T00:00:00.000Z"),
});

function arrangeRows(rows: ReturnType<typeof createVideo>[]) {
	mocks.select.mockImplementation((selection: Record<string, unknown>) => {
		const result =
			"ownerId" in selection
				? rows
				: "organizationId" in selection && !("settings" in selection)
					? mocks.sharedOrganizations
					: [];
		const query = {
			from: () => query,
			leftJoin: () => query,
			innerJoin: () => query,
			where: () => Promise.resolve(result),
		};
		return query;
	});
}

const renderPage = () =>
	ShareVideoPage({
		params: Promise.resolve({ videoId: "video" }),
		searchParams: Promise.resolve({}),
	});

async function renderAuthorizedContent() {
	const page = (await renderPage()) as ReactElement<{ children: unknown[] }>;
	const content = page.props.children[1];
	if (!isValidElement(content) || typeof content.type !== "function") {
		throw new Error("Expected authorized share content");
	}
	return (await (content.type as (props: unknown) => Promise<unknown>)(
		content.props,
	)) as ReactElement<{
		children: ReactElement<{
			initialPlaybackUrl?: Promise<string | null>;
			data: { sharedOrganizations: unknown[]; ownerIsOverShareLimit: boolean };
		}>;
	}>;
}

describe("share page loading", () => {
	beforeEach(() => {
		mocks.policy.mockReturnValue(Effect.void);
		mocks.reconcile.mockResolvedValue(false);
		mocks.playbackUrl.mockResolvedValue("https://media.example.com/result.mp4");
		mocks.quota.mockResolvedValue(false);
		mocks.user.mockResolvedValue(null);
		mocks.sharedOrganizations = [];
		arrangeRows([createVideo()]);
	});

	it("reuses the organization sharing query for the header and video data", async () => {
		mocks.sharedOrganizations = [
			{ id: "shared", organizationId: "shared", name: "Shared team" },
		];
		const content = await renderAuthorizedContent();
		expect(content.props.children.props.data.sharedOrganizations).toEqual([
			{ id: "shared", name: "Shared team" },
		]);
		expect(mocks.select).toHaveBeenCalledTimes(3);
	});

	it("does not expose videos belonging to a deleted organization", async () => {
		arrangeRows([{ ...createVideo(), organizationTombstoneAt: new Date() }]);
		await expect(renderPage()).rejects.toThrow("NOT_FOUND");
		expect(mocks.playbackUrl).not.toHaveBeenCalled();
	});

	it("loads ordinary recordings once and authorizes the exact loaded row", async () => {
		await renderPage();
		expect(mocks.select).toHaveBeenCalledOnce();
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.policy).toHaveBeenCalledExactlyOnceWith(
			createVideo(),
			Option.none(),
		);
	});

	it("retains stale edit recovery and reloads the row after recovery changes it", async () => {
		arrangeRows([
			{
				...createVideo(),
				activeUploadRawFileKey: "owner/video/source/original.mp4",
			},
		]);
		mocks.reconcile.mockImplementation(async () => {
			arrangeRows([createVideo()]);
			return true;
		});
		await renderPage();
		expect(mocks.select).toHaveBeenCalledTimes(2);
		expect(mocks.policy).toHaveBeenCalledExactlyOnceWith(
			createVideo(),
			Option.none(),
		);
	});

	it("does not sign playback URLs before private-video authorization succeeds", async () => {
		mocks.policy.mockReturnValue(Effect.fail({ _tag: "PolicyDenied" }));
		await renderPage();
		expect(mocks.playbackUrl).not.toHaveBeenCalled();
	});

	it("keeps password-protected videos behind the password overlay", async () => {
		mocks.policy.mockReturnValue(
			Effect.fail({ _tag: "VerifyVideoPasswordError" }),
		);
		const page = (await renderPage()) as ReactElement<{
			children: [ReactElement<{ isOpen: boolean }>, boolean];
		}>;
		expect(page.props.children[0].props.isOpen).toBe(true);
		expect(page.props.children[1]).toBe(false);
		expect(mocks.playbackUrl).not.toHaveBeenCalled();
	});

	it("streams the authorized MP4 URL without waiting for signing to finish", async () => {
		mocks.playbackUrl.mockReturnValue(new Promise(() => {}));
		const content = await renderAuthorizedContent();
		expect(content.props.children.props.initialPlaybackUrl).toBeInstanceOf(
			Promise,
		);
		expect(mocks.playbackUrl).toHaveBeenCalledOnce();
	});

	it("does not sign media hidden by the shareable link quota", async () => {
		mocks.quota.mockResolvedValue(true);
		const content = await renderAuthorizedContent();
		expect(await content.props.children.props.initialPlaybackUrl).toBeNull();
		expect(content.props.children.props.data.ownerIsOverShareLimit).toBe(true);
		expect(mocks.playbackUrl).not.toHaveBeenCalled();
	});

	it.each([
		{ isScreenshot: true },
		{ hasActiveUpload: true },
		{ source: { type: "desktopSegments" } },
		{ source: { type: "local" } },
		{ source: { type: "MediaConvert" } },
	])("retains the existing player resolution for %j", async (changes) => {
		arrangeRows([{ ...createVideo(), ...changes }]);
		const content = await renderAuthorizedContent();
		expect(content.props.children.props.initialPlaybackUrl).toBeUndefined();
		expect(mocks.playbackUrl).not.toHaveBeenCalled();
	});
});
