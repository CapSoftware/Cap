import { Video } from "@cap/web-domain";
import { describe, expect, it } from "vitest";
import type { PublicShareVideoCandidate } from "@/lib/public-share-video";
import { isPublicShareVideoCandidateEligible } from "@/lib/public-share-video";

const candidate = (
	overrides: Partial<PublicShareVideoCandidate> = {},
): PublicShareVideoCandidate => ({
	id: Video.VideoId.make("video123"),
	name: "Demo",
	ownerId: "owner123",
	ownerName: "Richie",
	public: true,
	hasPassword: false,
	hasInheritedPassword: false,
	allowedEmailDomain: null,
	linkOpenToAnyone: false,
	isScreenshot: false,
	hasActiveUpload: false,
	sourceType: "desktopMP4",
	jobStatus: "COMPLETE",
	skipProcessing: false,
	width: 1920,
	height: 1080,
	duration: 64,
	...overrides,
});

describe("public share video eligibility", () => {
	it("accepts a completed unrestricted public recording", () => {
		expect(isPublicShareVideoCandidateEligible(candidate())).toBe(true);
	});

	it.each([
		{ public: false },
		{ hasPassword: true },
		{ hasInheritedPassword: true },
		{ allowedEmailDomain: "@cap.so" },
		{ isScreenshot: true },
		{ hasActiveUpload: true },
	])("rejects restricted or non-video candidates", (override) => {
		expect(isPublicShareVideoCandidateEligible(candidate(override))).toBe(
			false,
		);
	});

	it("accepts a restricted organization's recording once its link is opened to anyone", () => {
		expect(
			isPublicShareVideoCandidateEligible(
				candidate({ allowedEmailDomain: "cap.so", linkOpenToAnyone: true }),
			),
		).toBe(true);
	});

	it.each([
		{ public: false },
		{ hasPassword: true },
		{ hasInheritedPassword: true },
	])("keeps an opened link behind %j", (override) => {
		expect(
			isPublicShareVideoCandidateEligible(
				candidate({
					allowedEmailDomain: "cap.so",
					linkOpenToAnyone: true,
					...override,
				}),
			),
		).toBe(false);
	});

	it("requires MediaConvert playback to be complete or explicitly skipped", () => {
		expect(
			isPublicShareVideoCandidateEligible(
				candidate({
					sourceType: "MediaConvert",
					jobStatus: "PROCESSING",
				}),
			),
		).toBe(false);
		expect(
			isPublicShareVideoCandidateEligible(
				candidate({
					sourceType: "MediaConvert",
					jobStatus: "PROCESSING",
					skipProcessing: true,
				}),
			),
		).toBe(true);
	});
});
