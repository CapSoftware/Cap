import { beforeEach, describe, expect, it, vi } from "vitest";

const checkRateLimitMock = vi.hoisted(() => vi.fn());
const headersMock = vi.hoisted(() => vi.fn());
const sendEmailMock = vi.hoisted(() => vi.fn());

vi.mock("@vercel/firewall", () => ({
	checkRateLimit: checkRateLimitMock,
}));

vi.mock("next/headers", () => ({
	headers: headersMock,
}));

vi.mock("@cap/database/emails/config", () => ({
	sendEmail: sendEmailMock,
}));

vi.mock("@cap/database/emails/download-link", () => ({
	DownloadLink: vi.fn(() => null),
}));

describe("sendDownloadLink", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		checkRateLimitMock.mockResolvedValue({ rateLimited: false });
		headersMock.mockResolvedValue(
			new Headers({ host: "cap.test", "x-real-ip": "127.0.0.1" }),
		);
		sendEmailMock.mockResolvedValue(undefined);
	});

	it("sends the email when the rate limit check passes", async () => {
		const { sendDownloadLink } = await import("@/actions/send-download-link");

		const result = await sendDownloadLink("user@example.com");

		expect(result).toEqual({ success: true });
		expect(sendEmailMock).toHaveBeenCalledTimes(1);
	});

	it("rejects the request when rate limited", async () => {
		checkRateLimitMock.mockResolvedValueOnce({ rateLimited: true });

		const { sendDownloadLink } = await import("@/actions/send-download-link");

		const result = await sendDownloadLink("user@example.com");

		expect(result).toEqual({
			success: false,
			error: "You've sent too many requests. Please try again later.",
		});
		expect(sendEmailMock).not.toHaveBeenCalled();
	});

	it("fails open when the rate limit check throws", async () => {
		checkRateLimitMock.mockRejectedValueOnce(
			new Error("Unexpected response 494"),
		);
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const { sendDownloadLink } = await import("@/actions/send-download-link");

		const result = await sendDownloadLink("user@example.com");

		expect(result).toEqual({ success: true });
		expect(sendEmailMock).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'Rate limit check failed for "rl_send_download_link":',
			expect.any(Error),
		);
	});
});
