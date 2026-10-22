import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	getCurrentUser: vi.fn(),
	revalidatePath: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { markAsRead } from "@/actions/notifications/mark-as-read";

beforeEach(() => {
	mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
	mocks.query.mockResolvedValue({ rows: [{ affectedRows: 1, insertId: 0 }] });
});

describe("notification read state", () => {
	it.each(["own-notification", "another-users-notification"])(
		"scopes an individual update to the current recipient for %s",
		async (notificationId) => {
			await markAsRead(notificationId);

			expect(mocks.query).toHaveBeenCalledExactlyOnceWith(
				expect.stringContaining(
					"where (`notifications`.`recipientId` = ? and `notifications`.`id` = ?)",
				),
				[expect.any(String), "user-1", notificationId],
				"execute",
			);
			expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
		},
	);

	it("marks all notifications for the current recipient when no ID is supplied", async () => {
		await markAsRead();

		expect(mocks.query).toHaveBeenCalledExactlyOnceWith(
			"update `notifications` set `readAt` = ? where `notifications`.`recipientId` = ?",
			[expect.any(String), "user-1"],
			"execute",
		);
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
	});

	it("succeeds without exposing whether a notification matched", async () => {
		mocks.query.mockResolvedValueOnce({
			rows: [{ affectedRows: 0, insertId: 0 }],
		});

		await expect(markAsRead("missing-notification")).resolves.toBeUndefined();

		expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
	});

	it("does not write when the requester is not authenticated", async () => {
		mocks.getCurrentUser.mockResolvedValueOnce(null);

		await expect(markAsRead("notification-1")).rejects.toThrow(
			"User not found",
		);

		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("reports a failed write without revalidating the dashboard", async () => {
		mocks.query.mockRejectedValueOnce(new Error("Database unavailable"));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(markAsRead("notification-1")).rejects.toThrow(
			"Error marking notification(s) as read",
		);

		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});
});
