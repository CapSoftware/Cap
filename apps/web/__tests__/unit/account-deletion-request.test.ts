import { User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const limitMock = vi.hoisted(() => vi.fn());
const forUpdateMock = vi.hoisted(() => vi.fn());
const valuesMock = vi.hoisted(() => vi.fn());
const sendEmailMock = vi.hoisted(() => vi.fn());
const messengerSupportEmailMock = vi.hoisted(() => vi.fn(() => null));
const nanoIdMock = vi.hoisted(() =>
	vi
		.fn()
		.mockReturnValueOnce("request-123")
		.mockReturnValueOnce("conversation-123")
		.mockReturnValueOnce("message-123"),
);

const mockDb = vi.hoisted(() => ({
	select: vi.fn(() => mockDb),
	from: vi.fn(() => mockDb),
	where: vi.fn(() => mockDb),
	for: forUpdateMock,
	limit: limitMock,
	insert: vi.fn(() => mockDb),
	values: valuesMock,
	transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(mockDb)),
}));

vi.mock("server-only", () => ({}));

vi.mock("@cap/database", () => ({
	db: vi.fn(() => mockDb),
}));

vi.mock("@cap/database/helpers", () => ({
	nanoId: nanoIdMock,
}));

vi.mock("@cap/database/schema", () => ({
	messengerConversations: {
		id: "conversationId",
	},
	messengerMessages: {
		id: "messageId",
	},
	messengerSupportEmails: {
		id: "id",
		conversationId: "conversationId",
		message: "message",
		subject: "subject",
		userEmail: "userEmail",
		userId: "userId",
	},
	users: {
		id: "userId",
	},
}));

vi.mock("@cap/database/emails/config", () => ({
	sendEmail: sendEmailMock,
}));

vi.mock("@cap/database/emails/messenger-support-email", () => ({
	MessengerSupportEmail: messengerSupportEmailMock,
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => ({ type: "and", conditions })),
	eq: vi.fn((left: unknown, right: unknown) => ({ type: "eq", left, right })),
	or: vi.fn((...conditions: unknown[]) => ({ type: "or", conditions })),
}));

describe("account deletion requests", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		nanoIdMock
			.mockReset()
			.mockReturnValueOnce("request-123")
			.mockReturnValueOnce("conversation-123")
			.mockReturnValueOnce("message-123");
		valuesMock.mockResolvedValue(undefined);
		forUpdateMock.mockResolvedValue([{ id: "user-123" }]);
		limitMock.mockResolvedValue([]);
		sendEmailMock.mockResolvedValue(undefined);
	});

	it("durably records a pending deletion before notifying support", async () => {
		const { createAccountDeletionRequest } = await import(
			"@/lib/account-deletion-request"
		);
		const now = new Date("2026-07-23T10:00:00.000Z");

		await expect(
			createAccountDeletionRequest({
				user: {
					id: User.UserId.make("user-123"),
					email: " User@Example.com ",
					name: "Test User",
				},
				now,
			}),
		).resolves.toEqual({
			id: "request-123",
			status: "created",
			notificationSent: true,
		});

		expect(valuesMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				id: "conversation-123",
				agent: "Millie",
				mode: "human",
				userId: "user-123",
				createdAt: now,
			}),
		);
		expect(valuesMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				id: "message-123",
				conversationId: "conversation-123",
				role: "user",
				userId: "user-123",
			}),
		);
		expect(valuesMock).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				id: "request-123",
				conversationId: "conversation-123",
				userEmail: "user@example.com",
				subject: "[PENDING] Account deletion request",
			}),
		);
		expect(sendEmailMock).toHaveBeenCalledWith(
			expect.objectContaining({
				email: "hello@cap.so",
				subject: "[PENDING] Account deletion request",
				replyTo: "user@example.com",
				idempotencyKey: "account-deletion-request-123",
			}),
		);
		expect(valuesMock.mock.invocationCallOrder[2]).toBeLessThan(
			sendEmailMock.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("returns an existing request without inserting a duplicate", async () => {
		limitMock.mockResolvedValueOnce([
			{
				id: "existing-request",
				conversationId: "existing-conversation",
				message: "Existing request",
			},
		]);
		const { createAccountDeletionRequest } = await import(
			"@/lib/account-deletion-request"
		);

		await expect(
			createAccountDeletionRequest({
				user: {
					id: User.UserId.make("user-123"),
					email: "user@example.com",
				},
			}),
		).resolves.toEqual({
			id: "existing-request",
			status: "existing",
			notificationSent: true,
		});

		expect(valuesMock).not.toHaveBeenCalled();
		expect(sendEmailMock).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "account-deletion-existing-request",
			}),
		);
	});

	it("keeps the durable request when notification delivery fails", async () => {
		sendEmailMock.mockRejectedValueOnce(new Error("email unavailable"));
		const { createAccountDeletionRequest } = await import(
			"@/lib/account-deletion-request"
		);

		await expect(
			createAccountDeletionRequest({
				user: {
					id: User.UserId.make("user-123"),
					email: "user@example.com",
				},
			}),
		).resolves.toEqual({
			id: "request-123",
			status: "created",
			notificationSent: false,
		});
		expect(valuesMock).toHaveBeenCalledTimes(3);
	});

	it("finds pending requests by user identity", async () => {
		limitMock.mockResolvedValueOnce([{ id: "request-123" }]);
		const { hasPendingAccountDeletion } = await import(
			"@/lib/account-deletion-request"
		);

		await expect(
			hasPendingAccountDeletion({
				userId: User.UserId.make("user-123"),
				email: "User@Example.com",
			}),
		).resolves.toBe(true);
	});

	it("durably records mobile content reports before notifying support", async () => {
		const { createMobileContentReport } = await import(
			"@/lib/account-deletion-request"
		);
		const now = new Date("2026-07-23T11:00:00.000Z");

		await expect(
			createMobileContentReport({
				reporter: {
					id: User.UserId.make("user-123"),
					email: "Reporter@Example.com",
					name: "Reporter",
				},
				content: {
					id: Video.VideoId.make("video-123"),
					ownerId: User.UserId.make("owner-123"),
					title: "Reported Cap",
				},
				reason: "harassment",
				now,
			}),
		).resolves.toEqual({
			id: "request-123",
			notificationSent: true,
		});

		expect(valuesMock).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				id: "request-123",
				userEmail: "reporter@example.com",
				subject: "[PENDING] Mobile content report",
				message: expect.stringContaining("Cap ID: video-123"),
			}),
		);
		expect(sendEmailMock).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "mobile-content-report-request-123",
				subject: "[PENDING] Mobile content report",
			}),
		);
		expect(valuesMock.mock.invocationCallOrder[2]).toBeLessThan(
			sendEmailMock.mock.invocationCallOrder[0] ?? 0,
		);
	});
});
