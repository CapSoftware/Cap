import { Context, Effect, Option } from "effect";
import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	select: vi.fn(),
	policy: vi.fn(),
	thumbnailUrl: vi.fn(),
	playbackUrl: vi.fn(),
	defaultStorage: true,
	userAgent: "",
	buildEnv: {
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
		NEXT_PUBLIC_IS_CAP: undefined as string | undefined,
	},
	quota: vi.fn(),
	user: vi.fn(),
	authenticated: false,
	ownerIsPro: false,
	sharedOrganizations: [] as {
		id: string;
		name: string;
		organizationId: string;
	}[],
}));

vi.mock("@cap/database", () => ({ db: () => ({ select: mocks.select }) }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@cap/env", () => ({
	buildEnv: mocks.buildEnv,
	serverEnv: () => ({}),
}));
vi.mock("@cap/ui", () => ({ Logo: () => null }));
vi.mock("@cap/utils", () => ({ userIsPro: () => mocks.ownerIsPro }));
vi.mock("@cap/web-backend", () => ({
	Database: Context.GenericTag("ShareTestDatabase"),
	ImageUploads: Context.GenericTag("ShareTestImages"),
	Videos: Context.GenericTag("ShareTestVideos"),
	provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		mocks.authenticated
			? Effect.provideService(Context.GenericTag("CurrentUser"), {
					id: "owner",
				})(effect)
			: effect,
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
				getThumbnailURL: mocks.thumbnailUrl,
			}),
			Effect.runPromise,
		),
}));
vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "user-agent": mocks.userAgent }),
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
}));
vi.mock("@/lib/video-view-count", () => ({
	getVideoViewCount: async () => ({ count: 12 }),
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
vi.mock("@/lib/share-playback", async (importActual) => ({
	canStartPlaybackInHtml: (
		await importActual<typeof import("@/lib/share-playback")>()
	).canStartPlaybackInHtml,
	getSharePlaybackSource: async (video: unknown) => {
		const url = (await mocks.playbackUrl(video)) as string | null;
		return url ? { url, defaultStorage: mocks.defaultStorage } : null;
	},
}));
vi.mock("@/lib/shareable-link-quota", () => ({
	isVideoOverShareableLinkLimit: mocks.quota,
}));
vi.mock("@/lib/share-web-url", () => ({ resolveShareWebUrl: vi.fn() }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/lib/video-download-permissions", () => ({
	canUserDownloadVideo: async () => false,
}));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: async () => false }));
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

import { PasswordGate } from "@/app/s/[videoId]/_components/PasswordGate";
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
	videoSettings: {
		callToAction: { label: "Book a call", url: "https://example.com/" },
	},
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
	const page = (await renderPage()) as ReactElement<{ children: unknown }>;
	const content = page.props.children;
	if (!isValidElement(content) || typeof content.type !== "function") {
		throw new Error("Expected authorized share content");
	}
	return (await (content.type as (props: unknown) => Promise<unknown>)(
		content.props,
	)) as ReactElement<{
		children: ReactElement<{
			initialPlaybackUrl?: Promise<string | null>;
			serverPlaybackUrl?: string | null;
			screenshotImageUrl?: string | null;
			data: {
				sharedOrganizations: unknown[];
				ownerIsOverShareLimit: boolean;
				callToAction: { label: string; url: string } | null;
			};
		}>;
	}>;
}

describe("share page loading", () => {
	beforeEach(() => {
		mocks.policy.mockReturnValue(Effect.void);
		mocks.thumbnailUrl.mockReturnValue(
			Effect.succeed(Option.some("https://media.example.com/image.jpg")),
		);
		mocks.playbackUrl.mockResolvedValue("https://media.example.com/result.mp4");
		mocks.quota.mockResolvedValue(false);
		mocks.defaultStorage = true;
		mocks.userAgent = "";
		mocks.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
		mocks.user.mockResolvedValue(null);
		mocks.authenticated = false;
		mocks.ownerIsPro = false;
		mocks.sharedOrganizations = [];
		arrangeRows([createVideo()]);
	});

	it.each([false, true])(
		"serves a saved call to action only when the owner has Pro: %s",
		async (ownerIsPro) => {
			mocks.ownerIsPro = ownerIsPro;
			const content = await renderAuthorizedContent();
			const callToAction = content.props.children.props.data.callToAction;
			if (ownerIsPro) {
				expect(callToAction).toMatchObject(
					createVideo().videoSettings.callToAction,
				);
			} else {
				expect(callToAction).toBeNull();
			}
		},
	);

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
		expect(mocks.policy).toHaveBeenCalledExactlyOnceWith(
			createVideo(),
			Option.none(),
		);
	});

	it("loads an active edit once and authorizes the current row", async () => {
		const video = {
			...createVideo(),
			hasActiveUpload: true,
			activeUploadRawFileKey: "owner/video/source/original.mp4",
		};
		arrangeRows([video]);
		await renderPage();
		expect(mocks.select).toHaveBeenCalledOnce();
		expect(mocks.policy).toHaveBeenCalledExactlyOnceWith(video, Option.none());
	});

	it.each([null, "owner/video/source/original.mp4"])(
		"does not sign playback URLs before authorization succeeds with upload %s",
		async (activeUploadRawFileKey) => {
			arrangeRows([
				{
					...createVideo(),
					hasActiveUpload: Boolean(activeUploadRawFileKey),
					activeUploadRawFileKey,
				},
			]);
			mocks.policy.mockReturnValue(Effect.fail({ _tag: "PolicyDenied" }));
			await renderPage();
			expect(mocks.playbackUrl).not.toHaveBeenCalled();
		},
	);

	it.each([null, "owner/video/source/original.mp4"])(
		"keeps password-protected videos behind the password gate with upload %s",
		async (activeUploadRawFileKey) => {
			arrangeRows([
				{
					...createVideo(),
					hasActiveUpload: Boolean(activeUploadRawFileKey),
					activeUploadRawFileKey,
				},
			]);
			mocks.policy.mockReturnValue(
				Effect.fail({ _tag: "VerifyVideoPasswordError" }),
			);
			const page = (await renderPage()) as ReactElement<{ videoId: string }>;
			expect(page.type).toBe(PasswordGate);
			expect(page.props.videoId).toBe(createVideo().id);
			expect(mocks.playbackUrl).not.toHaveBeenCalled();
		},
	);

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

	it("keeps the owner's auth context when loading a private screenshot", async () => {
		mocks.authenticated = true;
		arrangeRows([{ ...createVideo(), public: false, isScreenshot: true }]);
		mocks.thumbnailUrl.mockImplementation(() =>
			Effect.flatMap(Effect.context<never>(), (context) =>
				Option.isSome(
					Context.getOption(context, Context.GenericTag("CurrentUser")),
				)
					? Effect.succeed(Option.some("https://media.example.com/image.jpg"))
					: Effect.fail({ _tag: "PolicyDenied" }),
			),
		);

		const content = await renderAuthorizedContent();
		expect(content.props.children.props.screenshotImageUrl).toBe(
			"https://media.example.com/image.jpg",
		);
	});
});

describe("share page MP4 source in the HTML", () => {
	const CHROME =
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
	const SIGNED = "https://media.example.com/result.mp4";

	beforeEach(() => {
		mocks.policy.mockReturnValue(Effect.void);
		mocks.thumbnailUrl.mockReturnValue(
			Effect.succeed(Option.some("https://media.example.com/image.jpg")),
		);
		mocks.playbackUrl.mockResolvedValue(SIGNED);
		mocks.quota.mockResolvedValue(false);
		mocks.user.mockResolvedValue(null);
		mocks.authenticated = false;
		mocks.ownerIsPro = false;
		mocks.sharedOrganizations = [];
		mocks.defaultStorage = true;
		mocks.userAgent = CHROME;
		mocks.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
		arrangeRows([createVideo()]);
	});

	it("renders the signed URL for Cap's own storage", async () => {
		const content = await renderAuthorizedContent();
		expect(content.props.children.props.serverPlaybackUrl).toBe(SIGNED);
		expect(await content.props.children.props.initialPlaybackUrl).toBe(SIGNED);
		expect(mocks.playbackUrl).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"outside Cap Cloud",
			() => {
				mocks.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
			},
		],
		[
			"for a storage integration reported by the signer",
			() => {
				mocks.defaultStorage = false;
			},
		],
		[
			"over the shareable link quota",
			() => {
				mocks.quota.mockResolvedValue(true);
			},
		],
		[
			"for iPhone Safari",
			() => {
				mocks.userAgent =
					"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
			},
		],
		[
			"for desktop Safari, which may be an iPad",
			() => {
				mocks.userAgent =
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
			},
		],
	])("keeps client-side resolution %s", async (_name, arrange) => {
		arrange();
		const content = await renderAuthorizedContent();
		expect(content.props.children.props.serverPlaybackUrl).toBeNull();
	});

	it.each([{ bucket: "custom-bucket" }, { storageIntegrationId: "drive" }])(
		"does not wait for signing for %j",
		async (changes) => {
			arrangeRows([{ ...createVideo(), ...changes }]);
			mocks.playbackUrl.mockReturnValue(new Promise(() => {}));
			const content = await renderAuthorizedContent();
			expect(content.props.children.props.serverPlaybackUrl).toBeNull();
			expect(content.props.children.props.initialPlaybackUrl).toBeInstanceOf(
				Promise,
			);
		},
	);

	it("renders without the URL when signing is slow and still streams it to the player", async () => {
		mocks.playbackUrl.mockReturnValue(
			new Promise((resolve) => setTimeout(() => resolve(SIGNED), 200)),
		);
		const started = Date.now();
		const content = await renderAuthorizedContent();
		expect(Date.now() - started).toBeLessThan(180);
		expect(content.props.children.props.serverPlaybackUrl).toBeNull();
		expect(await content.props.children.props.initialPlaybackUrl).toBe(SIGNED);
	});
});
