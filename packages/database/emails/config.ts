import { buildEnv, serverEnv } from "@cap/env";
import type { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";

export const resend = () =>
	serverEnv().RESEND_API_KEY ? new Resend(serverEnv().RESEND_API_KEY) : null;

export const EMAIL_NOT_CONFIGURED_MESSAGE = "Email (Resend) is not configured";

export type EmailDeliveryStatus =
	| { configured: true }
	| { configured: false; reason: string };

export function getEmailDeliveryStatus(): EmailDeliveryStatus {
	const env = serverEnv();
	if (!env.RESEND_API_KEY) {
		return {
			configured: false,
			reason: `${EMAIL_NOT_CONFIGURED_MESSAGE}: RESEND_API_KEY is not set`,
		};
	}
	if (!buildEnv.NEXT_PUBLIC_IS_CAP && !env.RESEND_FROM_DOMAIN?.trim()) {
		return {
			configured: false,
			reason: `${EMAIL_NOT_CONFIGURED_MESSAGE}: RESEND_FROM_DOMAIN is not set`,
		};
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
	attachments?: {
		filename: string;
		content: Buffer | string;
		contentType?: string;
	}[];
}): Promise<SendEmailResult | undefined> => {
	const status = getEmailDeliveryStatus();
	const r = resend();
	if (!status.configured || !r) {
		const reason = status.configured
			? EMAIL_NOT_CONFIGURED_MESSAGE
			: status.reason;
		warnEmailNotConfigured(reason);
		return {
			data: null,
			error: { name: "email_not_configured", message: reason },
		};
	}

	if (marketing && !buildEnv.NEXT_PUBLIC_IS_CAP) return;
	let from: string;

	if (fromOverride) from = fromOverride;
	else if (marketing) from = "Richie from Cap <richie@send.cap.so>";
	else if (buildEnv.NEXT_PUBLIC_IS_CAP)
		from = "Cap Auth <no-reply@auth.cap.so>";
	else from = `auth@${serverEnv().RESEND_FROM_DOMAIN}`;

	const result = await r.emails.send(
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
			`[email] Resend rejected email "${subject}" from ${from}:`,
			result.error.message,
		);
		return {
			data: null,
			error: { name: result.error.name, message: result.error.message },
		};
	}

	return { data: result.data, error: null };
};
