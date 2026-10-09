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
	selected: vi.fn(),
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
					fixtures.selected(table);
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

	it.each(["viewer@example.com", "invalid"])(
		"rejects a non-owner before validating %s",
		async (email) => {
			fixtures.user.mockResolvedValue({ id: "other-1" });

			await expect(inviteVideoViewer(VIDEO_ID, email)).rejects.toThrow(
				"Unauthorized",
			);
			expect(fixtures.inserted).not.toHaveBeenCalled();
			expect(fixtures.sendEmail).not.toHaveBeenCalled();
		},
	);

	it("rejects an unauthenticated caller before validation or database access", async () => {
		fixtures.user.mockResolvedValue(null);

		await expect(inviteVideoViewer(VIDEO_ID, "invalid")).rejects.toThrow(
			"Unauthorized",
		);
		expect(fixtures.selected).not.toHaveBeenCalled();
		expect(fixtures.inserted).not.toHaveBeenCalled();
		expect(fixtures.sendEmail).not.toHaveBeenCalled();
		expect(fixtures.revalidatePath).not.toHaveBeenCalled();
	});

	it.each([
		"",
		"   ",
		"invalid",
		"viewer@example",
		"viewer@@example.com",
		"view er@example.com",
		"viewer@example.com,other@example.com",
		"viewer\n@example.com",
		`${"a".repeat(243)}@example.com`,
	])(
		"returns validation feedback for %j without looking up or changing grants",
		async (email) => {
			await expect(inviteVideoViewer(VIDEO_ID, email)).resolves.toEqual({
				success: false,
				error: "Enter a valid email address",
			});
			expect(fixtures.selected).toHaveBeenCalledExactlyOnceWith(schema.videos);
			expect(fixtures.inserted).not.toHaveBeenCalled();
			expect(fixtures.updated).not.toHaveBeenCalled();
			expect(fixtures.sendEmail).not.toHaveBeenCalled();
			expect(fixtures.revalidatePath).not.toHaveBeenCalled();
		},
	);

	it("still accepts 254 characters after trimming and lowercasing", async () => {
		const email = `${"A".repeat(242)}@Example.com`;
		const result = await inviteVideoViewer(VIDEO_ID, ` ${email} `);

		expect(result.success).toBe(true);
		expect(fixtures.inserted).toHaveBeenCalledWith(
			expect.objectContaining({ email: email.toLowerCase() }),
		);
		expect(fixtures.sendEmail).toHaveBeenCalledOnce();
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

		expect(result).toMatchObject({ success: true, emailSent: false });
		expect(fixtures.inserted).toHaveBeenCalledOnce();
	});

	it("does not resend an invitation for an active grant", async () => {
		fixtures.grants = ["viewer@example.com"];

		const result = await inviteVideoViewer(VIDEO_ID, "Viewer@Example.com");

		expect(result).toEqual({
			success: true,
			alreadyAdded: true,
			emailSent: false,
		});
		expect(fixtures.inserted).not.toHaveBeenCalled();
		expect(fixtures.sendEmail).not.toHaveBeenCalled();
	});

	it("can invite an email again after its grant was revoked", async () => {
		fixtures.grants = ["viewer@example.com"];
		fixtures.revokedEmails = ["viewer@example.com"];

		const result = await inviteVideoViewer(VIDEO_ID, "viewer@example.com");

		expect(result).toMatchObject({
			success: true,
			alreadyAdded: false,
			emailSent: true,
		});
		expect(fixtures.inserted).toHaveBeenCalledOnce();
		expect(fixtures.sendEmail).toHaveBeenCalledOnce();
	});

	it("keeps unexpected grant failures as errors", async () => {
		fixtures.inserted.mockRejectedValueOnce(new Error("Database unavailable"));

		await expect(
			inviteVideoViewer(VIDEO_ID, "viewer@example.com"),
		).rejects.toThrow("Database unavailable");
		expect(fixtures.sendEmail).not.toHaveBeenCalled();
		expect(fixtures.revalidatePath).not.toHaveBeenCalled();
	});

	it("keeps granted access when email delivery throws", async () => {
		fixtures.sendEmail.mockRejectedValueOnce(new Error("Delivery unavailable"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			inviteVideoViewer(VIDEO_ID, "viewer@example.com"),
		).resolves.toEqual({
			success: true,
			alreadyAdded: false,
			emailSent: false,
		});
		expect(fixtures.inserted).toHaveBeenCalledOnce();
		expect(fixtures.revalidatePath).toHaveBeenCalledWith(`/s/${VIDEO_ID}`);
		expect(log).toHaveBeenCalledOnce();
	});

	it("preserves invalid-address rejection when revoking", async () => {
		await expect(revokeVideoViewer(VIDEO_ID, "invalid")).rejects.toThrow(
			"Enter a valid email address",
		);
		expect(fixtures.updated).not.toHaveBeenCalled();
		expect(fixtures.revalidatePath).not.toHaveBeenCalled();
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
