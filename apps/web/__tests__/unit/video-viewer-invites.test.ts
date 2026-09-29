import type { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getVideoViewerGrants,
	inviteVideoViewer,
	revokeVideoViewer,
} from "@/actions/videos/viewer-invites";

const fixtures = vi.hoisted(() => ({
	user: vi.fn(),
	sendEmail: vi.fn(),
	revalidatePath: vi.fn(),
	video: { id: "video-1", ownerId: "owner-1", name: "Demo" },
	grants: [] as string[],
	revokedEmails: [] as string[],
	inserted: vi.fn(),
	updated: vi.fn(),
}));

const schema = vi.hoisted(() => ({
	videos: { id: "videoId", name: "videoName", ownerId: "videoOwnerId" },
	videoViewerGrants: {
		videoId: "grantVideoId",
		email: "grantEmail",
		revokedAt: "grantRevokedAt",
	},
}));

vi.mock("@cap/database", () => ({
	db: () => {
		let selectedTable: unknown;
		return {
			select: () => ({
				from: (table: unknown) => {
					selectedTable = table;
					return {
						where: () => ({
							limit: async () =>
								selectedTable === schema.videos
									? [fixtures.video]
									: fixtures.grants.map((email) => ({
											email,
											revokedAt: fixtures.revokedEmails.includes(email)
												? new Date(0)
												: null,
										})),
							orderBy: async () => fixtures.grants.map((email) => ({ email })),
						}),
					};
				},
			}),
			insert: () => ({
				values: (value: unknown) => ({
					onDuplicateKeyUpdate: async () => fixtures.inserted(value),
				}),
			}),
			update: () => ({
				set: (value: unknown) => ({
					where: async () => fixtures.updated(value),
				}),
			}),
		};
	},
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: fixtures.user,
}));
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: fixtures.sendEmail,
}));
vi.mock("@cap/database/emails/video-viewer-invite", () => ({
	VideoViewerInvite: () => null,
}));
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "grant-1",
}));
vi.mock("@cap/database/schema", () => schema);
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("drizzle-orm", () => ({
	and: vi.fn((...parts: unknown[]) => parts),
	eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
	isNull: vi.fn((column: unknown) => ({ column })),
}));
vi.mock("next/cache", () => ({
	revalidatePath: fixtures.revalidatePath,
}));

const VIDEO_ID = "video-1" as Video.VideoId;

describe("recording viewer invitations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fixtures.grants = [];
		fixtures.revokedEmails = [];
		fixtures.video.ownerId = "owner-1";
		fixtures.user.mockResolvedValue({ id: "owner-1" });
		fixtures.sendEmail.mockResolvedValue({
			data: { id: "email-1" },
			error: null,
		});
	});

	it("rejects a non-owner before writing a grant or sending email", async () => {
		fixtures.user.mockResolvedValue({ id: "other-1" });

		await expect(
			inviteVideoViewer(VIDEO_ID, "viewer@example.com"),
		).rejects.toThrow("Unauthorized");
		expect(fixtures.inserted).not.toHaveBeenCalled();
		expect(fixtures.sendEmail).not.toHaveBeenCalled();
	});

	it("grants access to the normalized email and sends the recording link", async () => {
		const result = await inviteVideoViewer(VIDEO_ID, " Viewer@Example.com ");

		expect(result).toEqual({
			success: true,
			alreadyAdded: false,
			emailSent: true,
		});
		expect(fixtures.inserted).toHaveBeenCalledWith(
			expect.objectContaining({
				videoId: VIDEO_ID,
				email: "viewer@example.com",
			}),
		);
		expect(fixtures.sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({ email: "viewer@example.com" }),
		);
	});

	it("keeps access when email delivery is unavailable so the owner can share the link", async () => {
		fixtures.sendEmail.mockResolvedValue(undefined);

		const result = await inviteVideoViewer(VIDEO_ID, "viewer@example.com");

		expect(result.emailSent).toBe(false);
		expect(fixtures.inserted).toHaveBeenCalledOnce();
	});

	it("does not resend an invitation for an active grant", async () => {
		fixtures.grants = ["viewer@example.com"];

		const result = await inviteVideoViewer(VIDEO_ID, "Viewer@Example.com");

		expect(result.alreadyAdded).toBe(true);
		expect(fixtures.inserted).not.toHaveBeenCalled();
		expect(fixtures.sendEmail).not.toHaveBeenCalled();
	});

	it("can invite an email again after its grant was revoked", async () => {
		fixtures.grants = ["viewer@example.com"];
		fixtures.revokedEmails = ["viewer@example.com"];

		const result = await inviteVideoViewer(VIDEO_ID, "viewer@example.com");

		expect(result.alreadyAdded).toBe(false);
		expect(fixtures.inserted).toHaveBeenCalledOnce();
		expect(fixtures.sendEmail).toHaveBeenCalledOnce();
	});

	it("keeps the invited viewer list and removal owner-only", async () => {
		fixtures.grants = ["viewer@example.com"];
		fixtures.user.mockResolvedValue({ id: "other-1" });
		await expect(getVideoViewerGrants(VIDEO_ID)).rejects.toThrow(
			"Unauthorized",
		);
		await expect(
			revokeVideoViewer(VIDEO_ID, "viewer@example.com"),
		).rejects.toThrow("Unauthorized");
		expect(fixtures.updated).not.toHaveBeenCalled();
	});

	it("marks a viewer grant revoked when the owner removes it", async () => {
		fixtures.grants = ["viewer@example.com"];

		await expect(
			revokeVideoViewer(VIDEO_ID, "Viewer@Example.com"),
		).resolves.toEqual({
			success: true,
		});
		expect(fixtures.updated).toHaveBeenCalledWith({
			revokedAt: expect.any(Date),
		});
		expect(fixtures.revalidatePath).toHaveBeenCalledWith(`/s/${VIDEO_ID}`);
	});
});
