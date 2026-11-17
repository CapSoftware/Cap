import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	sendEmail: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: mocks.sendEmail,
}));

import { sendFirstViewEmail } from "@/lib/Notification";

type Pauses = { pauseViews?: boolean; pauseAnonViews?: boolean };

function storeVideo(pauses: Pauses) {
	let firstViewEmailSentAt: Date | null = null;
	const preferences = {
		notifications: {
			pauseComments: false,
			pauseReplies: false,
			pauseReactions: false,
			pauseViews: false,
			pauseAnonViews: false,
			...pauses,
		},
	};

	mocks.query.mockImplementation(async (query: string) => {
		if (query.startsWith("select") && query.includes("from `videos`"))
			return {
				rows: [
					[
						firstViewEmailSentAt,
						"Demo",
						"owner",
						"owner@example.com",
						preferences,
					],
				],
			};
		if (query.startsWith("update `videos`")) {
			if (firstViewEmailSentAt) return { rows: [{ affectedRows: 0 }] };
			firstViewEmailSentAt = new Date();
			return { rows: [{ affectedRows: 1 }] };
		}
		if (query.startsWith("select") && query.includes("from `users`"))
			return { rows: [["Teammate", "teammate@example.com"]] };
		throw new Error(`Unexpected query: ${query}`);
	});

	return { firstViewRecorded: () => firstViewEmailSentAt !== null };
}

const anonymousView = () =>
	sendFirstViewEmail({
		videoId: "video",
		viewerName: "Anonymous Otter",
		isAnonymous: true,
	});

const signedInView = () =>
	sendFirstViewEmail({
		videoId: "video",
		viewerUserId: "teammate",
		isAnonymous: false,
	});

beforeEach(() => {
	mocks.query.mockReset();
	mocks.sendEmail.mockReset();
});

describe("first view email", () => {
	it("emails the owner once about the first view", async () => {
		storeVideo({});

		await anonymousView();
		await signedInView();

		expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
		expect(mocks.sendEmail.mock.calls[0]?.[0]).toMatchObject({
			email: "owner@example.com",
		});
	});

	it.each([
		{
			paused: "anonymous views",
			pauses: { pauseAnonViews: true },
			firstView: anonymousView,
			laterView: signedInView,
		},
		{
			paused: "signed-in views",
			pauses: { pauseViews: true },
			firstView: signedInView,
			laterView: anonymousView,
		},
	])(
		"still records a first view when $paused are paused, so a later view is not announced as the first",
		async ({ pauses, firstView, laterView }) => {
			const video = storeVideo(pauses);

			await firstView();

			expect(video.firstViewRecorded()).toBe(true);
			expect(mocks.sendEmail).not.toHaveBeenCalled();

			await laterView();

			expect(mocks.sendEmail).not.toHaveBeenCalled();
		},
	);

	it("does not record the owner watching their own Cap as its first view", async () => {
		const video = storeVideo({});

		await sendFirstViewEmail({
			videoId: "video",
			viewerUserId: "owner",
			isAnonymous: false,
		});

		expect(video.firstViewRecorded()).toBe(false);
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});
});
