import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: {} as Record<string, string | number | undefined>,
	build: {} as Record<string, string | undefined>,
	send: vi.fn(),
	sendMail: vi.fn(),
	createTransport: vi.fn(),
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

vi.mock("nodemailer", () => ({
	createTransport: (options: unknown) => {
		mocks.createTransport(options);
		return { sendMail: mocks.sendMail };
	},
}));

vi.mock("@react-email/render", () => ({
	render: async (_node: unknown, options?: { plainText?: boolean }) =>
		options?.plainText ? "plain body" : "<p>html body</p>",
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
		mocks.sendMail.mockReset();
		mocks.createTransport.mockReset();
		for (const key of Object.keys(mocks.env)) delete mocks.env[key];
		for (const key of Object.keys(mocks.build)) delete mocks.build[key];
	});

	it("reports missing RESEND_API_KEY", () => {
		const status = getEmailDeliveryStatus();
		expect(status.configured).toBe(false);
		expect(status.configured ? "" : status.reason).toContain(
			"Email is not configured",
		);
		expect(status.configured ? "" : status.reason).toContain("RESEND_API_KEY");
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

	describe("SMTP", () => {
		const configureSmtp = () => {
			mocks.env.SMTP_HOST = "smtp.example.com";
			mocks.env.SMTP_PORT = 587;
			mocks.env.SMTP_FROM = "Cap <auth@example.com>";
		};

		it("sends through SMTP when SMTP_HOST is set, even with Resend configured", async () => {
			configureSmtp();
			mocks.env.RESEND_API_KEY = "re_test";
			mocks.env.RESEND_FROM_DOMAIN = "example.com";
			mocks.sendMail.mockResolvedValue({ messageId: "<smtp-1@example.com>" });

			expect(getEmailDeliveryStatus().configured).toBe(true);
			const result = await sendEmail(message);

			expect(mocks.send).not.toHaveBeenCalled();
			expect(mocks.sendMail).toHaveBeenCalledWith(
				expect.objectContaining({
					from: "Cap <auth@example.com>",
					to: "user@example.com",
					subject: "Hello",
					html: "<p>html body</p>",
					text: "plain body",
				}),
			);
			expect(result).toEqual({
				data: { id: "<smtp-1@example.com>" },
				error: null,
			});
		});

		it("does not fall back to Resend when SMTP_FROM is missing", async () => {
			mocks.env.SMTP_HOST = "smtp.example.com";
			mocks.env.RESEND_API_KEY = "re_test";
			mocks.env.RESEND_FROM_DOMAIN = "example.com";

			const status = getEmailDeliveryStatus();
			expect(status.configured ? "" : status.reason).toContain("SMTP_FROM");

			const result = await sendEmail(message);
			expect(mocks.send).not.toHaveBeenCalled();
			expect(mocks.sendMail).not.toHaveBeenCalled();
			expect(result?.error?.name).toBe("email_not_configured");
		});

		it("passes sender override, cc, replyTo and attachments through", async () => {
			configureSmtp();
			mocks.sendMail.mockResolvedValue({ messageId: "<smtp-2@example.com>" });
			const attachments = [
				{
					filename: "baa.pdf",
					content: Buffer.from("pdf"),
					contentType: "application/pdf",
				},
			];

			await sendEmail({
				...message,
				fromOverride: "Cap Support <support@example.com>",
				cc: ["a@example.com", "b@example.com"],
				replyTo: "reply@example.com",
				attachments,
			});

			expect(mocks.sendMail).toHaveBeenCalledWith(
				expect.objectContaining({
					from: "Cap Support <support@example.com>",
					cc: ["a@example.com", "b@example.com"],
					replyTo: "reply@example.com",
					attachments,
				}),
			);
		});

		it("bounds timeouts and requires TLS before sending credentials", async () => {
			configureSmtp();
			mocks.env.SMTP_USER = "user";
			mocks.env.SMTP_PASSWORD = "secret";
			mocks.sendMail.mockResolvedValue({ messageId: "<smtp-3@example.com>" });

			await sendEmail(message);

			expect(mocks.createTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					host: "smtp.example.com",
					port: 587,
					secure: false,
					requireTLS: true,
					auth: { user: "user", pass: "secret" },
					connectionTimeout: 10_000,
					greetingTimeout: 10_000,
					socketTimeout: 30_000,
				}),
			);
		});

		it("uses implicit TLS on port 465 and skips auth without credentials", async () => {
			configureSmtp();
			mocks.env.SMTP_PORT = 465;
			mocks.sendMail.mockResolvedValue({ messageId: "<smtp-4@example.com>" });

			await sendEmail(message);

			expect(mocks.createTransport).toHaveBeenCalledWith(
				expect.objectContaining({
					port: 465,
					secure: true,
					requireTLS: false,
					auth: undefined,
				}),
			);
		});

		it("surfaces SMTP failures with the transport error code", async () => {
			configureSmtp();
			mocks.sendMail.mockRejectedValue(
				Object.assign(new Error("Invalid login"), { code: "EAUTH" }),
			);

			const result = await sendEmail(message);

			expect(result).toEqual({
				data: null,
				error: { name: "EAUTH", message: "Invalid login" },
			});
		});

		it("does not deliver test emails", async () => {
			configureSmtp();

			const result = await sendEmail({ ...message, test: true });

			expect(mocks.sendMail).not.toHaveBeenCalled();
			expect(result?.error).toBeNull();
		});

		it.each([undefined, "false"])(
			"skips marketing on self-hosts with NEXT_PUBLIC_IS_CAP=%j",
			async (isCap) => {
				mocks.build.NEXT_PUBLIC_IS_CAP = isCap;
				configureSmtp();

				await sendEmail({ ...message, marketing: true });

				expect(mocks.sendMail).not.toHaveBeenCalled();
			},
		);
	});
});
