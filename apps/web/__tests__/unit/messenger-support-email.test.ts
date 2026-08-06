import { User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const whereMock = vi.hoisted(() => vi.fn());
const forUpdateMock = vi.hoisted(() => vi.fn());
const valuesMock = vi.hoisted(() => vi.fn());
const sendEmailMock = vi.hoisted(() => vi.fn());
const messengerSupportEmailMock = vi.hoisted(() => vi.fn(() => null));

const mockDb = vi.hoisted(() => ({
	select: vi.fn(() => mockDb),
	from: vi.fn(() => mockDb),
	where: whereMock,
	for: forUpdateMock,
	insert: vi.fn(() => mockDb),
	values: valuesMock,
	transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(mockDb)),
}));

vi.mock("server-only", () => ({}));

vi.mock("@cap/database", () => ({
	db: vi.fn(() => mockDb),
}));

vi.mock("@cap/database/helpers", () => ({
	nanoId: vi.fn(() => "support-email-123"),
}));

vi.mock("@cap/database/schema", () => ({
	messengerSupportEmails: {
		userId: "userId",
		createdAt: "createdAt",
	},
	users: {
		id: "id",
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
	count: vi.fn(() => "count"),
	eq: vi.fn((left: unknown, right: unknown) => ({ type: "eq", left, right })),
	gte: vi.fn((left: unknown, right: unknown) => ({ type: "gte", left, right })),
}));

describe("sendMessengerSupportEmail", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		valuesMock.mockResolvedValue(undefined);
		forUpdateMock.mockResolvedValue([{ id: "user-123" }]);
		sendEmailMock.mockResolvedValue(undefined);
	});

	it("sends support email from account context and records the send", async () => {
		whereMock.mockReturnValueOnce(mockDb).mockResolvedValueOnce([{ value: 1 }]);
		const { sendMessengerSupportEmail } = await import(
			"@/lib/messenger/support-email"
		);

		const result = await sendMessengerSupportEmail({
			user: {
				id: User.UserId.make("user-123"),
				email: "user@example.com",
				name: "Test User",
			},
			conversationId: "conversation-123",
			subject: "  Upload\nissue  ",
			message: "  Uploads keep failing.  ",
			now: new Date("2026-06-30T18:00:00.000Z"),
		});

		expect(result).toEqual({
			status: "sent",
			remainingToday: 0,
		});
		expect(forUpdateMock).toHaveBeenCalledWith("update");
		expect(messengerSupportEmailMock).toHaveBeenCalledWith({
			userEmail: "user@example.com",
			userName: "Test User",
			conversationId: "conversation-123",
			message: "Uploads keep failing.",
		});
		expect(sendEmailMock).toHaveBeenCalledWith(
			expect.objectContaining({
				email: "hello@cap.so",
				subject: "Messenger support: Upload issue",
				replyTo: "user@example.com",
				fromOverride: "Cap Support <richie@send.cap.so>",
			}),
		);
		expect(valuesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "support-email-123",
				conversationId: "conversation-123",
				userId: "user-123",
				userEmail: "user@example.com",
				subject: "Upload issue",
				message: "Uploads keep failing.",
				createdAt: new Date("2026-06-30T18:00:00.000Z"),
			}),
		);
		const insertCallOrder = valuesMock.mock.invocationCallOrder[0];
		const sendCallOrder = sendEmailMock.mock.invocationCallOrder[0];
		if (insertCallOrder === undefined || sendCallOrder === undefined) {
			throw new Error("Expected insert and send call order");
		}
		expect(insertCallOrder).toBeLessThan(sendCallOrder);
	});

	it("does not send after two support emails in the same UTC day", async () => {
		whereMock.mockReturnValueOnce(mockDb).mockResolvedValueOnce([{ value: 2 }]);
		const { sendMessengerSupportEmail } = await import(
			"@/lib/messenger/support-email"
		);

		const result = await sendMessengerSupportEmail({
			user: {
				id: User.UserId.make("user-123"),
				email: "user@example.com",
				name: "Test User",
			},
			conversationId: "conversation-123",
			subject: "Upload issue",
			message: "Uploads keep failing.",
			now: new Date("2026-06-30T18:00:00.000Z"),
		});

		expect(result).toEqual({
			status: "rate_limited",
			remainingToday: 0,
		});
		expect(sendEmailMock).not.toHaveBeenCalled();
		expect(valuesMock).not.toHaveBeenCalled();
	});

	it("does not send when the audit reservation fails", async () => {
		whereMock.mockReturnValueOnce(mockDb).mockResolvedValueOnce([{ value: 1 }]);
		valuesMock.mockRejectedValueOnce(new Error("insert failed"));
		const { sendMessengerSupportEmail } = await import(
			"@/lib/messenger/support-email"
		);

		await expect(
			sendMessengerSupportEmail({
				user: {
					id: User.UserId.make("user-123"),
					email: "user@example.com",
					name: "Test User",
				},
				conversationId: "conversation-123",
				subject: "Upload issue",
				message: "Uploads keep failing.",
				now: new Date("2026-06-30T18:00:00.000Z"),
			}),
		).rejects.toThrow("insert failed");

		expect(sendEmailMock).not.toHaveBeenCalled();
	});
});
