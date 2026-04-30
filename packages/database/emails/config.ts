import { buildEnv, serverEnv } from "@cap/env";
import { render } from "@react-email/render";
import nodemailer from "nodemailer";
import type { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";

export const resend = () =>
	serverEnv().RESEND_API_KEY ? new Resend(serverEnv().RESEND_API_KEY) : null;

let _smtpTransport: ReturnType<typeof nodemailer.createTransport> | null | undefined;

export const smtp = () => {
	if (_smtpTransport !== undefined) return _smtpTransport;
	const env = serverEnv();
	if (!env.SMTP_HOST) {
		_smtpTransport = null;
		return null;
	}
	_smtpTransport = nodemailer.createTransport({
		host: env.SMTP_HOST,
		port: env.SMTP_PORT,
		secure: env.SMTP_SECURE,
		auth:
			env.SMTP_USER && env.SMTP_PASS
				? { user: env.SMTP_USER, pass: env.SMTP_PASS }
				: undefined,
	});
	return _smtpTransport;
};

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
}: {
	email: string;
	subject: string;
	react: ReactElement<any, string | JSXElementConstructor<any>>;
	marketing?: boolean;
	test?: boolean;
	scheduledAt?: string;
	cc?: string | string[];
	replyTo?: string;
	fromOverride?: string;
}) => {
	if (marketing && !buildEnv.NEXT_PUBLIC_IS_CAP) return;

	let from: string;
	if (fromOverride) from = fromOverride;
	else if (marketing) from = "Richie from Cap <richie@send.cap.so>";
	else if (buildEnv.NEXT_PUBLIC_IS_CAP)
		from = "Cap Auth <no-reply@auth.cap.so>";
	else if (serverEnv().SMTP_FROM) from = serverEnv().SMTP_FROM!;
	else if (serverEnv().RESEND_FROM_DOMAIN)
		from = `auth@${serverEnv().RESEND_FROM_DOMAIN}`;
	else {
		// No from-address configured. Most SMTP servers reject "noreply@localhost"
		// as invalid sender, which would silently drop the email. Fail loudly instead.
		throw new Error(
			"No email from-address configured. Set SMTP_FROM (when using SMTP) or RESEND_FROM_DOMAIN (when using Resend).",
		);
	}

	// Resend has a sandbox sink at delivered@resend.dev for test mode;
	// over SMTP we just use the real recipient
	const to = test && !smtp() ? "delivered@resend.dev" : email;

	// Try SMTP first if configured (preferred for self-hosted)
	const transport = smtp();
	if (transport) {
		const html = await render(react);
		return transport.sendMail({
			from,
			to,
			subject,
			html,
			cc: test ? undefined : cc,
			replyTo,
		}) as any;
	}

	// Fall back to Resend if configured
	const r = resend();
	if (!r) {
		return Promise.resolve();
	}

	return r.emails.send({
		from,
		to,
		subject,
		react,
		scheduledAt,
		cc: test ? undefined : cc,
		replyTo: replyTo,
	}) as any;
};
