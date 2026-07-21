import { Folder, Mobile, Organisation, User, Video } from "@cap/web-domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

describe("mobile API contract schemas", () => {
	it("decodes bootstrap responses without exposing database rows", () => {
		const decoded = Schema.decodeUnknownSync(Mobile.MobileBootstrapResponse)({
			user: {
				id: User.UserId.make("user_123"),
				name: "Richie",
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
		});

		expect(decoded.user.email).toBe("richie@example.com");
		expect(decoded.rootFolders[0]?.videoCount).toBe(4);
	});

	it("decodes auth provider availability", () => {
		const decoded = Schema.decodeUnknownSync(Mobile.MobileAuthConfigResponse)({
			googleAuthAvailable: true,
			workosAuthAvailable: false,
		});

		expect(decoded.googleAuthAvailable).toBe(true);
		expect(decoded.workosAuthAvailable).toBe(false);
	});

	it("accepts Google and WorkOS mobile session providers", () => {
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
		});

		expect(decoded).toEqual({
			name: "Product",
			color: "blue",
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
			cap: {
				id: Video.VideoId.make("video_123"),
				shareUrl: "https://cap.so/s/video_123",
				title: "Launch review",
				createdAt: "2026-05-18T10:00:00.000Z",
				updatedAt: "2026-05-18T10:30:00.000Z",
				ownerName: "Richie",
				durationSeconds: null,
				thumbnailUrl: null,
				folderId: null,
				public: true,
				protected: false,
				viewCount: 0,
				commentCount: 0,
				reactionCount: 0,
				upload: {
					uploaded: 0,
					total: 0,
					phase: "uploading",
					processingProgress: 0,
					processingMessage: null,
					processingError: null,
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
});
