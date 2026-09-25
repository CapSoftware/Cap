import { User, Video } from "@cap/web-domain";
import { describe, expect, it } from "vitest";
import {
	type MobileCapRow,
	toMobileCapSummary,
} from "@/lib/mobile-cap-summary";

const row: MobileCapRow = {
	id: Video.VideoId.make("example-video"),
	ownerId: User.UserId.make("example-owner"),
	ownerPreferences: null,
	name: "Team update",
	createdAt: new Date("2024-01-01"),
	updatedAt: new Date("2024-01-02"),
	ownerName: "Example Owner",
	duration: 12,
	folderId: null,
	public: true,
	videoSharingRestrictedToOrg: false,
	hasPassword: false,
	hasInheritedPassword: false,
	commentCount: 0,
	reactionCount: 0,
	uploadVideoId: null,
	uploadUploaded: null,
	uploadTotal: null,
	uploadPhase: null,
	processingProgress: null,
	processingMessage: null,
	processingError: null,
	metadata: null,
	transcriptionStatus: "COMPLETE",
};
const member = User.UserId.make("example-member");
const summarize = (overrides: Partial<MobileCapRow>, viewer = member) =>
	toMobileCapSummary(
		{ ...row, ...overrides },
		0,
		"https://example.invalid",
		viewer,
	);

describe("mobile recording sharing indicators", () => {
	it.each([
		{ hasPassword: true },
		{ hasInheritedPassword: true },
		{ hasPassword: true, hasInheritedPassword: true },
	])(
		"overrides saved password flags for organization-only recordings",
		(saved) => {
			const summary = summarize({
				...saved,
				videoSharingRestrictedToOrg: true,
			});
			expect(summary.public).toBe(false);
			expect(summary.protected).toBe(false);
			expect(summary.thumbnailUrl).toContain(`/caps/${row.id}/thumbnail`);
			expect(summary.thumbnailCacheKey).not.toBeNull();
		},
	);

	it.each([{ hasPassword: true }, { hasInheritedPassword: true }])(
		"restores saved protection when organization-only access is disabled",
		(saved) => {
			const summary = summarize(saved);
			expect(summary.public).toBe(true);
			expect(summary.protected).toBe(true);
			expect(summary.thumbnailUrl).toBeNull();
		},
	);

	it("preserves owner thumbnails for normal password-protected recordings", () => {
		expect(
			summarize({ hasPassword: true }, row.ownerId).thumbnailUrl,
		).not.toBeNull();
	});

	it("keeps in-progress upload thumbnails hidden under the organization policy", () => {
		const summary = summarize({
			videoSharingRestrictedToOrg: true,
			uploadVideoId: row.id,
			uploadPhase: "uploading",
		});
		expect(summary.thumbnailUrl).toBeNull();
		expect(summary.upload?.phase).toBe("uploading");
	});
});
