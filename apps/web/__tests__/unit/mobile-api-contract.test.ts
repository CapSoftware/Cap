import {
	Folder,
	Mobile,
	Organisation,
	Space,
	User,
	Video,
} from "@cap/web-domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

describe("mobile API contract schemas", () => {
	it("enforces the five-minute free recording limit with segment tolerance", () => {
		expect(
			Mobile.isMobileRecordingDurationAllowed({
				durationSeconds: 305,
				isPro: false,
			}),
		).toBe(true);
		expect(
			Mobile.isMobileRecordingDurationAllowed({
				durationSeconds: 305.01,
				isPro: false,
			}),
		).toBe(false);
		expect(
			Mobile.isMobileRecordingDurationAllowed({
				durationSeconds: 3600,
				isPro: true,
			}),
		).toBe(true);
	});

	it("decodes bootstrap responses without exposing database rows", () => {
		const decoded = Schema.decodeUnknownSync(Mobile.MobileBootstrapResponse)({
			user: {
				id: User.UserId.make("user_123"),
				name: "Richie",
				lastName: "McIlroy",
				email: "richie@example.com",
				imageUrl: null,
				activeOrganizationId: Organisation.OrganisationId.make("org_123"),
			},
			organizations: [
				{
					id: Organisation.OrganisationId.make("org_123"),
					name: "Cap",
					iconUrl: null,
					role: "owner",
				},
			],
			activeOrganizationId: Organisation.OrganisationId.make("org_123"),
			rootFolders: [
				{
					id: Folder.FolderId.make("folder_123"),
					name: "Product",
					color: "blue",
					parentId: null,
					videoCount: 4,
				},
			],
			spaces: [
				{
					id: Organisation.OrganisationId.make("org_123"),
					name: "All Cap",
					iconUrl: null,
					kind: "organization",
					privacy: "Public",
					role: "owner",
					canManage: true,
					hasPassword: false,
				},
				{
					id: Space.SpaceId.make("space_123"),
					name: "Product",
					iconUrl: null,
					kind: "space",
					privacy: "Private",
					role: "admin",
					canManage: true,
					hasPassword: true,
				},
			],
		});

		expect(decoded.user.email).toBe("richie@example.com");
		expect(decoded.user.lastName).toBe("McIlroy");
		expect(decoded.rootFolders[0]?.videoCount).toBe(4);
		expect(decoded.spaces?.map((space) => space.name)).toEqual([
			"All Cap",
			"Product",
		]);
	});

	it("decodes auth provider availability", () => {
		const decoded = Schema.decodeUnknownSync(Mobile.MobileAuthConfigResponse)({
			appleAuthAvailable: true,
			googleAuthAvailable: true,
			workosAuthAvailable: false,
		});

		expect(decoded.appleAuthAvailable).toBe(true);
		expect(decoded.googleAuthAvailable).toBe(true);
		expect(decoded.workosAuthAvailable).toBe(false);
	});

	it("decodes mobile profile and profile image updates", () => {
		const profile = Schema.decodeUnknownSync(Mobile.MobileProfileInput)({
			name: "Richie",
			lastName: "McIlroy",
		});
		const image = Schema.decodeUnknownSync(Mobile.MobileProfileImageInput)({
			data: "iVBORw0KGgo=",
			contentType: "image/png",
			fileName: "profile.png",
		});

		expect(profile.lastName).toBe("McIlroy");
		expect(image.fileName).toBe("profile.png");
	});

	it("requires explicit account deletion confirmation", () => {
		expect(
			Schema.decodeUnknownSync(Mobile.MobileAccountDeletionInput)({
				confirmation: "DELETE",
			}).confirmation,
		).toBe("DELETE");
		expect(() =>
			Schema.decodeUnknownSync(Mobile.MobileAccountDeletionInput)({
				confirmation: "delete",
			}),
		).toThrow();
	});

	it("decodes mobile content reports and user blocks", () => {
		expect(
			Schema.decodeUnknownSync(Mobile.MobileContentReportInput)({
				reason: "harassment",
			}).reason,
		).toBe("harassment");
		expect(
			Schema.decodeUnknownSync(Mobile.MobileUserBlockInput)({
				userId: User.UserId.make("user_456"),
			}).userId,
		).toBe("user_456");
		expect(() =>
			Schema.decodeUnknownSync(Mobile.MobileContentReportInput)({
				reason: "spam",
			}),
		).toThrow();
	});

	it("accepts Apple, Google, and WorkOS mobile session providers", () => {
		expect(
			Schema.decodeUnknownSync(Mobile.MobileSessionRequestParams)({
				redirectUri: "cap://auth",
				provider: "apple",
			}).provider,
		).toBe("apple");
		expect(
			Schema.decodeUnknownSync(Mobile.MobileSessionRequestParams)({
				redirectUri: "cap://auth",
				provider: "google",
			}).provider,
		).toBe("google");
		expect(
			Schema.decodeUnknownSync(Mobile.MobileSessionRequestParams)({
				redirectUri: "cap://auth",
				provider: "workos",
				organizationId: "org_123",
			}).organizationId,
		).toBe("org_123");
	});

	it("builds signed-out Apple login redirects", () => {
		const requestUrl =
			"/api/mobile/session/request?provider=apple&redirectUri=cap%3A%2F%2Fauth";
		const loginRedirectUrl = Mobile.createMobileSessionLoginRedirectUrl({
			deploymentOrigin: "https://cap.so",
			requestUrl,
			provider: "apple",
		});

		expect(loginRedirectUrl.pathname).toBe("/login");
		expect(loginRedirectUrl.searchParams.get("mobileProvider")).toBe("apple");
		expect(
			new URL(loginRedirectUrl.searchParams.get("next") ?? "").searchParams.get(
				"provider",
			),
		).toBe("apple");
	});

	it("builds signed-out Google login redirects from relative request URLs", () => {
		const redirectUri =
			"exp+cap://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081%2F--%2Fauth";
		const requestUrl = `/api/mobile/session/request?provider=google&redirectUri=${encodeURIComponent(redirectUri)}`;
		const loginRedirectUrl = Mobile.createMobileSessionLoginRedirectUrl({
			deploymentOrigin: "http://localhost:3000",
			requestUrl,
			provider: "google",
		});
		const continuationUrl = new URL(
			loginRedirectUrl.searchParams.get("next") ?? "",
		);

		expect(loginRedirectUrl.origin).toBe("http://localhost:3000");
		expect(loginRedirectUrl.pathname).toBe("/login");
		expect(loginRedirectUrl.searchParams.get("mobileProvider")).toBe("google");
		expect(continuationUrl.origin).toBe("http://localhost:3000");
		expect(continuationUrl.pathname).toBe("/api/mobile/session/request");
		expect(continuationUrl.searchParams.get("provider")).toBe("google");
		expect(continuationUrl.searchParams.get("redirectUri")).toBe(redirectUri);
	});

	it("allows only mobile auth callback redirects for session requests", () => {
		const decodeRedirect = (redirectUri: string) =>
			Schema.decodeUnknownSync(Mobile.MobileSessionRequestParams)({
				redirectUri,
				provider: "google",
			});

		expect(decodeRedirect("cap://auth").redirectUri).toBe("cap://auth");
		expect(
			decodeRedirect("exp+cap://expo-development-client/--/auth").redirectUri,
		).toBe("exp+cap://expo-development-client/--/auth");
		expect(
			decodeRedirect(
				"exp+cap://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081%2F--%2Fauth",
			).redirectUri,
		).toBe(
			"exp+cap://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081%2F--%2Fauth",
		);

		expect(() => decodeRedirect("cap://auth/")).toThrow();
		expect(() => decodeRedirect("cap://auth?next=cap://settings")).toThrow();
		expect(() => decodeRedirect("cap://user:pass@auth")).toThrow();
		expect(() => decodeRedirect("cap://settings")).toThrow();
		expect(() => decodeRedirect("cap://auth.evil")).toThrow();
		expect(() => decodeRedirect("https://cap.so/auth")).toThrow();
		expect(() =>
			decodeRedirect("exp+cap://expo-development-client:123/--/auth"),
		).toThrow();
		expect(() =>
			decodeRedirect("exp+cap://expo-development-client/--/settings"),
		).toThrow();
	});

	it("decodes Cap sharing visibility updates", () => {
		const decoded = Schema.decodeUnknownSync(Mobile.MobileCapSharingInput)({
			public: false,
		});

		expect(decoded.public).toBe(false);
	});

	it("decodes collection-wide Cap counts", () => {
		const decoded = Schema.decodeUnknownSync(Mobile.MobileCapsListResponse)({
			folders: [],
			caps: [],
			page: 1,
			limit: 30,
			total: 12,
			collectionTotal: 45,
			hasMore: false,
		});

		expect(decoded.collectionTotal).toBe(45);
	});

	it("decodes compact Cap upload statuses", () => {
		const decoded = Schema.decodeUnknownSync(Mobile.MobileCapStatusesResponse)({
			caps: [
				{
					id: Video.VideoId.make("video_123"),
					upload: {
						uploaded: 500,
						total: 1000,
						phase: "uploading",
						processingProgress: 0,
						processingMessage: null,
						processingError: null,
					},
				},
			],
		});

		expect(decoded.caps[0]?.upload?.uploaded).toBe(500);
	});

	it("decodes Cap title updates", () => {
		const decoded = Schema.decodeUnknownSync(Mobile.MobileCapTitleInput)({
			title: "Roadmap review",
		});

		expect(decoded.title).toBe("Roadmap review");
	});

	it("decodes Cap password updates", () => {
		expect(
			Schema.decodeUnknownSync(Mobile.MobileCapPasswordInput)({
				password: "secret",
			}).password,
		).toBe("secret");
		expect(
			Schema.decodeUnknownSync(Mobile.MobileCapPasswordInput)({
				password: null,
			}).password,
		).toBeNull();
	});

	it("decodes mobile folder creation inputs", () => {
		const decoded = Schema.decodeUnknownSync(Mobile.MobileFolderCreateInput)({
			name: "Product",
			color: "blue",
			spaceId: Space.SpaceId.make("space_123"),
		});

		expect(decoded).toEqual({
			name: "Product",
			color: "blue",
			spaceId: "space_123",
		});
	});

	it("requires mobile caps dates to be serialized strings", () => {
		expect(() =>
			Schema.decodeUnknownSync(Mobile.MobileCapSummary)({
				id: Video.VideoId.make("video_123"),
				shareUrl: "https://cap.so/s/video_123",
				title: "Launch review",
				createdAt: new Date("2026-05-18T10:00:00.000Z"),
				updatedAt: "2026-05-18T10:30:00.000Z",
				ownerName: "Richie",
				durationSeconds: 125,
				thumbnailUrl: null,
				folderId: null,
				public: true,
				protected: false,
				viewCount: 7,
				commentCount: 2,
				reactionCount: 3,
				upload: null,
			}),
		).toThrow();
	});

	it("decodes signed playback and upload targets", () => {
		const playback = Schema.decodeUnknownSync(Mobile.MobilePlaybackResponse)({
			kind: "mp4",
			url: "https://signed.example/video.mp4",
			transcriptUrl: "https://signed.example/transcript.vtt",
		});
		const upload = Schema.decodeUnknownSync(Mobile.MobileUploadCreateResponse)({
			id: Video.VideoId.make("video_123"),
			shareUrl: "https://cap.so/s/video_123",
			rawFileKey: "user_123/video_123/raw-upload.mp4",
			upload: {
				type: "put",
				url: "https://signed.example/upload",
				headers: {
					"Content-Type": "video/mp4",
				},
			},
		});

		expect(playback.url).toContain("signed.example");
		expect(upload.upload.type).toBe("put");
	});

	it("decodes segmented mobile recording contracts", () => {
		const targets = Schema.decodeUnknownSync(
			Mobile.MobileRecordingUploadTargetsResponse,
		)({
			uploads: {
				"segments/video/init.mp4": {
					type: "put",
					url: "https://signed.example/init",
					headers: { "Content-Type": "video/mp4" },
				},
			},
		});
		const complete = Schema.decodeUnknownSync(
			Mobile.MobileRecordingCompleteInput,
		)({
			durationSeconds: 12.4,
			totalBytes: 4_000_000,
			videoSegments: [
				{ index: 1, duration: 2.02 },
				{ index: 2, duration: 1.98 },
			],
			audioSegments: [
				{ index: 1, duration: 2 },
				{ index: 2, duration: 2 },
			],
		});

		expect(targets.uploads["segments/video/init.mp4"]?.type).toBe("put");
		expect(complete.videoSegments).toHaveLength(2);
		expect(complete.audioSegments).toHaveLength(2);
	});

	it("decodes native analytics, organization settings, and Loom imports", () => {
		const analytics = Schema.decodeUnknownSync(Mobile.MobileAnalyticsResponse)({
			available: true,
			data: {
				capName: "Launch review",
				counts: { caps: 1, views: 12, comments: 2, reactions: 3 },
				chart: [
					{
						bucket: "2026-07-21T12:00:00Z",
						caps: 0,
						views: 12,
						comments: 2,
						reactions: 3,
					},
				],
				breakdowns: {
					countries: [{ name: "United Kingdom", views: 8, percentage: 66.7 }],
					cities: [],
					browsers: [],
					operatingSystems: [],
					devices: [],
					topCaps: [
						{
							id: Video.VideoId.make("video_123"),
							name: "Launch review",
							views: 12,
							percentage: 100,
						},
					],
				},
			},
		});
		const organization = Schema.decodeUnknownSync(
			Mobile.MobileOrganizationSettings,
		)({
			id: Organisation.OrganisationId.make("org_123"),
			name: "Cap",
			role: "admin",
			canManage: true,
			iconUrl: null,
			allowedEmailDomain: "cap.so",
			customDomain: "video.cap.so",
			domainVerified: true,
		});
		const loom = Schema.decodeUnknownSync(Mobile.MobileLoomImportResponse)({
			id: Video.VideoId.make("video_456"),
			shareUrl: "https://cap.so/s/video_456",
		});

		expect(analytics.data?.counts.views).toBe(12);
		expect(organization.canManage).toBe(true);
		expect(loom.id).toBe("video_456");
	});
});
