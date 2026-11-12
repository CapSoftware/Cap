import { buildEnv, serverEnv } from "@cap/env";
import type { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";
import { sendViaSmtp } from "./smtp";

export const resend = () =>
	serverEnv().RESEND_API_KEY ? new Resend(serverEnv().RESEND_API_KEY) : null;

export const EMAIL_NOT_CONFIGURED_MESSAGE = "Email is not configured";

const CAP_CLOUD_AUTH_FROM = "Cap Auth <no-reply@auth.cap.so>";
const CAP_MARKETING_FROM = "Richie from Cap <richie@send.cap.so>";

type EmailConfig =
	| {
			transport: "smtp";
			host: string;
			defaultFrom: string | undefined;
			missingFromReason: string;
	  }
	| {
			transport: "resend";
			client: Resend;
			defaultFrom: string | undefined;
			missingFromReason: string;
	  }
	| { transport: null; reason: string };

function resolveEmailConfig(): EmailConfig {
	const env = serverEnv();
	const smtpHost = env.SMTP_HOST?.trim();
	if (smtpHost) {
		const from = env.SMTP_FROM?.trim();
		return {
			transport: "smtp",
			host: smtpHost,
			defaultFrom: from?.includes("@") ? from : undefined,
			missingFromReason: `${EMAIL_NOT_CONFIGURED_MESSAGE}: SMTP_FROM is not set`,
		};
	}

	const client = resend();
	if (client) {
		const domain = env.RESEND_FROM_DOMAIN?.trim();
		return {
			transport: "resend",
			client,
			defaultFrom:
				buildEnv.NEXT_PUBLIC_IS_CAP === "true"
					? CAP_CLOUD_AUTH_FROM
					: domain
						? `auth@${domain}`
						: undefined,
			missingFromReason: `${EMAIL_NOT_CONFIGURED_MESSAGE}: RESEND_FROM_DOMAIN is not set`,
		};
	}

	return {
		transport: null,
		reason: `${EMAIL_NOT_CONFIGURED_MESSAGE}: SMTP_HOST or RESEND_API_KEY is not set`,
	};
}

export type EmailDeliveryStatus =
	| { configured: true }
	| { configured: false; reason: string };

export function getEmailDeliveryStatus(): EmailDeliveryStatus {
	const config = resolveEmailConfig();
	if (!config.transport) return { configured: false, reason: config.reason };
	if (!config.defaultFrom) {
		return { configured: false, reason: config.missingFromReason };
	}
	return { configured: true };
}

export const isEmailDeliveryConfigured = () =>
	getEmailDeliveryStatus().configured;

let warnedEmailNotConfigured = false;

function warnEmailNotConfigured(reason: string) {
	if (warnedEmailNotConfigured) return;
	warnedEmailNotConfigured = true;
	console.warn(
		`[email] ${reason}. Emails will not be sent; login codes are printed to the server log instead.`,
	);
}

type SendEmailAttachment = {
	filename: string;
	content: Buffer | string;
	contentType?: string;
};

export type SendEmailResult =
	| { data: { id: string } | null; error: null }
	| { data: null; error: { name: string; message: string } };

export const sendEmail = async ({
	email,
	subject,
	react,
	marketing,
	test,
	scheduledAt,
	cc,
	replyTo,
	fromOverride,
	idempotencyKey,
	attachments,
}: {
	email: string;
	subject: string;
	react: ReactElement<unknown, string | JSXElementConstructor<unknown>>;
	marketing?: boolean;
	test?: boolean;
	scheduledAt?: string;
	cc?: string | string[];
	replyTo?: string;
	fromOverride?: string;
	idempotencyKey?: string;
	attachments?: SendEmailAttachment[];
}): Promise<SendEmailResult | undefined> => {
	const config = resolveEmailConfig();
	if (!config.transport) return emailNotConfigured(config.reason);

	const isCap = buildEnv.NEXT_PUBLIC_IS_CAP === "true";
	if (marketing && !isCap) return;
	const from =
		fromOverride || (marketing ? CAP_MARKETING_FROM : config.defaultFrom);
	if (!from?.includes("@")) return emailNotConfigured(config.missingFromReason);

	if (config.transport === "smtp") {
		if (test) return { data: { id: "smtp-test" }, error: null };
		if (scheduledAt) {
			console.warn(
				`[email] SMTP cannot schedule delivery; sending "${subject}" now instead of ${scheduledAt}`,
			);
		}
	}

	const result =
		config.transport === "smtp"
			? await sendViaSmtp({
					host: config.host,
					from,
					to: email,
					subject,
					react,
					cc,
					replyTo,
					attachments,
				})
			: await config.client.emails.send(
					{
						from,
						to: test ? "delivered@resend.dev" : email,
						subject,
						react,
						scheduledAt,
						cc: test ? undefined : cc,
						replyTo: replyTo,
						attachments,
					},
					idempotencyKey ? { idempotencyKey } : undefined,
				);

	if (result.error) {
		console.error(
			`[email] ${config.transport === "smtp" ? "SMTP server" : "Resend"} rejected email "${subject}" from ${from}:`,
			result.error.message,
		);
		return {
			data: null,
			error: { name: result.error.name, message: result.error.message },
		};
	}

	return { data: result.data, error: null };
};

function emailNotConfigured(reason: string): SendEmailResult {
	warnEmailNotConfigured(reason);
	return {
		data: null,
		error: { name: "email_not_configured", message: reason },
	};
}
