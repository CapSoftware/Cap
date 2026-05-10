import { buildEnv, serverEnv } from "@cap/env";
import { renderAsync } from "@react-email/render";
import type { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";

type CloudflareEmailSender = string | { email: string; name: string };

export const resend = () =>
	serverEnv().RESEND_API_KEY ? new Resend(serverEnv().RESEND_API_KEY) : null;

const cloudflareEmail = () => {
	const env = serverEnv();

	if (!env.CLOUDFLARE_EMAIL_WORKER_URL || !env.CLOUDFLARE_EMAIL_SECRET) {
		return null;
	}

	return {
		secret: env.CLOUDFLARE_EMAIL_SECRET,
		url: env.CLOUDFLARE_EMAIL_WORKER_URL,
	};
};

export const emailTransportConfigured = () =>
	Boolean(cloudflareEmail() || resend());

const cloudflareSender = (
	fromDomain: string,
	marketing?: boolean,
): CloudflareEmailSender => {
	if (marketing) return { email: `updates@${fromDomain}`, name: "Updates" };
	if (buildEnv.NEXT_PUBLIC_IS_CAP)
		return { email: `auth@${fromDomain}`, name: "Auth" };
	return `auth@${fromDomain}`;
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
	react: ReactElement<unknown, string | JSXElementConstructor<unknown>>;
	marketing?: boolean;
	test?: boolean;
	scheduledAt?: string;
	cc?: string | string[];
	replyTo?: string;
	fromOverride?: string;
}) => {
	if (marketing && !buildEnv.NEXT_PUBLIC_IS_CAP) return;
	let from: string;
	const fromDomain =
		serverEnv().CLOUDFLARE_EMAIL_FROM_DOMAIN ??
		serverEnv().RESEND_FROM_DOMAIN ??
		"shashanksn.xyz";

	if (fromOverride) from = fromOverride;
	else if (marketing) from = `Updates <updates@${fromDomain}>`;
	else if (buildEnv.NEXT_PUBLIC_IS_CAP) from = `Auth <auth@${fromDomain}>`;
	else from = `auth@${fromDomain}`;

	const cf = cloudflareEmail();
	if (cf) {
		const html = await renderAsync(react);
		const response = await fetch(cf.url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${cf.secret}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				cc: test ? undefined : cc,
				from: cloudflareSender(fromDomain, marketing),
				html,
				replyTo,
				subject,
				to: test ? "emailshashanksn@gmail.com" : email,
			}),
		});

		if (!response.ok) {
			throw new Error(await response.text());
		}

		return response.json();
	}

	const r = resend();
	if (!r) {
		return Promise.resolve();
	}

	return r.emails.send({
		from,
		to: test ? "delivered@resend.dev" : email,
		subject,
		react,
		scheduledAt,
		cc: test ? undefined : cc,
		replyTo: replyTo,
	});
};
