import { serverEnv } from "@cap/env";
import { ResendEmailProvider } from "./resend";
import { SmtpEmailProvider } from "./smtp";
import type { EmailProvider } from "./types";

let cached: EmailProvider | null | undefined;

export function getEmailProvider(): EmailProvider | null {
	if (cached !== undefined) return cached;
	cached = build();
	return cached;
}

export function resetEmailProvider(): void {
	cached = undefined;
}

function build(): EmailProvider | null {
	const env = serverEnv();
	const requested =
		env.EMAIL_PROVIDER ?? (env.RESEND_API_KEY ? "resend" : null);

	if (requested === "smtp") {
		if (!env.SMTP_HOST || !env.SMTP_PORT) {
			console.warn(
				"[email] EMAIL_PROVIDER=smtp but SMTP_HOST/SMTP_PORT missing — emails disabled",
			);
			return null;
		}
		if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) {
			console.warn(
				"[email] Only one of SMTP_USER/SMTP_PASS is set: SMTP auth is disabled. Set both or neither.",
			);
		}
		return new SmtpEmailProvider({
			host: env.SMTP_HOST,
			port: env.SMTP_PORT,
			secure: env.SMTP_SECURE,
			user: env.SMTP_USER,
			pass: env.SMTP_PASS,
		});
	}

	if (requested === "resend") {
		if (!env.RESEND_API_KEY) {
			console.warn(
				"[email] EMAIL_PROVIDER=resend but RESEND_API_KEY missing — emails disabled",
			);
			return null;
		}
		return new ResendEmailProvider(env.RESEND_API_KEY);
	}

	return null;
}

export type { EmailProvider } from "./types";
