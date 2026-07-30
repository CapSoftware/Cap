import {
	organizationMembers,
	sharedVideos,
	spaceMembers,
	spaceVideos,
} from "@cap/database/schema";
import type { Organisation, User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canUserDownloadVideo } from "../../../lib/video-download-permissions";

let mockSharedOrgs: Array<{ organizationId: string }> = [];
let mockOrgMembers: Array<{ id: string }> = [];
let mockSharedSpaces: Array<{ spaceId: string }> = [];
let mockSpaceMembers: Array<{ id: string }> = [];

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: unknown) => ({
				where: (condition: any) => {
					let result: unknown[] = [];
					if (table === sharedVideos) {
						result = mockSharedOrgs;
					} else if (table === organizationMembers) {
						// Simple condition check for tests: if the where clause doesn't include the target orgs/users, return empty
						const getCircularReplacer = () => {
							const seen = new WeakSet();
							return (key: string, value: any) => {
								if (typeof value === "object" && value !== null) {
									if (seen.has(value)) return;
									seen.add(value);
								}
								return value;
							};
						};
						const conditionStr = JSON.stringify(condition, getCircularReplacer()) || "";
						if (mockOrgMembers.length > 0 && !conditionStr.includes("org-789")) {
							result = [];
						} else {
							result = mockOrgMembers;
						}
					} else if (table === spaceVideos) {
						result = mockSharedSpaces;
					} else if (table === spaceMembers) {
						result = mockSpaceMembers;
					}
					const promise = Promise.resolve(result);
					(promise as Record<string, unknown>).limit = () =>
						Promise.resolve(result);
					return promise;
				},
			}),
		}),
	}),
}));

describe("canUserDownloadVideo", () => {
	beforeEach(() => {
		mockSharedOrgs = [];
		mockOrgMembers = [];
		mockSharedSpaces = [];
		mockSpaceMembers = [];
	});

	it("grants download access to the video owner", async () => {
		const allowed = await canUserDownloadVideo({
			userId: "user-123" as User.UserId,
			ownerId: "user-123" as User.UserId,
			videoId: "vid-456" as Video.VideoId,
			orgId: "org-789" as Organisation.OrganisationId,
		});

		expect(allowed).toBe(true);
	});

	it("denies download access to an org member when the video is not explicitly shared with the organization", async () => {
		mockSharedOrgs = [];
		mockOrgMembers = [{ id: "member-1" }];
		mockSharedSpaces = [];
		mockSpaceMembers = [];

		const allowed = await canUserDownloadVideo({
			userId: "user-123" as User.UserId,
			ownerId: "user-456" as User.UserId,
			videoId: "vid-789" as Video.VideoId,
			orgId: "org-789" as Organisation.OrganisationId,
		});

		expect(allowed).toBe(false);
	});

	it("grants download access to an org member when the video is explicitly shared with the organization", async () => {
		mockSharedOrgs = [{ organizationId: "org-789" }];
		mockOrgMembers = [{ id: "member-1" }];
		mockSharedSpaces = [];
		mockSpaceMembers = [];

		const allowed = await canUserDownloadVideo({
			userId: "user-123" as User.UserId,
			ownerId: "user-456" as User.UserId,
			videoId: "vid-789" as Video.VideoId,
			orgId: "org-789" as Organisation.OrganisationId,
		});

		expect(allowed).toBe(true);
	});

	it("denies download access when the video is shared with a different organization", async () => {
		mockSharedOrgs = [{ organizationId: "other-org-id" }];
		mockOrgMembers = [{ id: "member-1" }];
		mockSharedSpaces = [];
		mockSpaceMembers = [];

		const allowed = await canUserDownloadVideo({
			userId: "user-123" as User.UserId,
			ownerId: "user-456" as User.UserId,
			videoId: "vid-789" as Video.VideoId,
			orgId: "org-789" as Organisation.OrganisationId,
		});

		expect(allowed).toBe(false);
	});
});
