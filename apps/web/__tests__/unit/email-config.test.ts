import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
	build: {} as Record<string, string | undefined>,
	send: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => mocks.env,
	buildEnv: mocks.build,
}));

vi.mock("resend", () => ({
	Resend: class {
		emails = { send: mocks.send };
	},
}));

import { getEmailDeliveryStatus, sendEmail } from "@cap/database/emails/config";

const message = {
	email: "user@example.com",
	subject: "Hello",
	react: null as unknown as Parameters<typeof sendEmail>[0]["react"],
};

describe("email config", () => {
	beforeEach(() => {
		mocks.send.mockReset();
		for (const key of Object.keys(mocks.env)) delete mocks.env[key];
		for (const key of Object.keys(mocks.build)) delete mocks.build[key];
	});

	it("reports missing RESEND_API_KEY", () => {
		const status = getEmailDeliveryStatus();
		expect(status.configured).toBe(false);
		expect(status.configured ? "" : status.reason).toContain(
			"Email (Resend) is not configured",
		);
	});

	it.each([undefined, "", "false"])(
		"requires a sender domain with NEXT_PUBLIC_IS_CAP=%j",
		async (isCap) => {
			mocks.build.NEXT_PUBLIC_IS_CAP = isCap;
			mocks.env.RESEND_API_KEY = "re_test";
			expect(getEmailDeliveryStatus().configured).toBe(false);

			const result = await sendEmail(message);
			expect(mocks.send).not.toHaveBeenCalled();
			expect(result?.error?.name).toBe("email_not_configured");
		},
	);

	it("sends an explicit sender without a default from-domain", async () => {
		mocks.env.RESEND_API_KEY = "re_test";
		mocks.send.mockResolvedValue({ data: { id: "email_2" }, error: null });

		const result = await sendEmail({
			...message,
			fromOverride: "Cap Support <richie@send.cap.so>",
		});

		expect(mocks.send.mock.calls[0]?.[0].from).toBe(
			"Cap Support <richie@send.cap.so>",
		);
		expect(result).toEqual({ data: { id: "email_2" }, error: null });
	});

	it.each([undefined, "false"])(
		"sends from the configured domain with NEXT_PUBLIC_IS_CAP=%j",
		async (isCap) => {
			mocks.build.NEXT_PUBLIC_IS_CAP = isCap;
			mocks.env.RESEND_API_KEY = "re_test";
			mocks.env.RESEND_FROM_DOMAIN = "example.com";
			mocks.send.mockResolvedValue({ data: { id: "email_1" }, error: null });

			const result = await sendEmail(message);
			expect(mocks.send.mock.calls[0]?.[0].from).toBe("auth@example.com");
			expect(result).toEqual({ data: { id: "email_1" }, error: null });
		},
	);

	it("uses the Cap Cloud sender when explicitly enabled", async () => {
		mocks.build.NEXT_PUBLIC_IS_CAP = "true";
		mocks.env.RESEND_API_KEY = "re_test";
		mocks.send.mockResolvedValue({ data: { id: "cloud_email" }, error: null });

		expect(getEmailDeliveryStatus().configured).toBe(true);
		await sendEmail(message);

		expect(mocks.send.mock.calls[0]?.[0].from).toBe(
			"Cap Auth <no-reply@auth.cap.so>",
		);
	});

	it.each([undefined, "false"])(
		"skips marketing on self-hosts with NEXT_PUBLIC_IS_CAP=%j",
		async (isCap) => {
			mocks.build.NEXT_PUBLIC_IS_CAP = isCap;
			mocks.env.RESEND_API_KEY = "re_test";
			mocks.env.RESEND_FROM_DOMAIN = "example.com";
			mocks.send.mockResolvedValue({ data: { id: "marketing" }, error: null });

			await sendEmail({ ...message, marketing: true });

			expect(mocks.send).not.toHaveBeenCalled();
		},
	);

	it("surfaces provider rejections instead of claiming success", async () => {
		mocks.env.RESEND_API_KEY = "re_test";
		mocks.env.RESEND_FROM_DOMAIN = "example.com";
		mocks.send.mockResolvedValue({
			data: null,
			error: { name: "validation_error", message: "domain not verified" },
		});

		const result = await sendEmail(message);
		expect(result?.error?.message).toBe("domain not verified");
	});
});
