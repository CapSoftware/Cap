import { buildEnv, serverEnv } from "@cap/env";
import type { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";
import { getEmailProvider } from "./providers";

export const resend = () =>
	serverEnv().RESEND_API_KEY ? new Resend(serverEnv().RESEND_API_KEY) : null;

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
	const provider = getEmailProvider();
	if (!provider) return;

	if (marketing && !buildEnv.NEXT_PUBLIC_IS_CAP) return;

	let from: string;
	if (fromOverride) from = fromOverride;
	else if (marketing) from = "Richie from Cap <richie@send.cap.so>";
	else if (buildEnv.NEXT_PUBLIC_IS_CAP)
		from = "Cap Auth <no-reply@auth.cap.so>";
	else {
		const env = serverEnv();
		if (env.EMAIL_FROM) from = env.EMAIL_FROM;
		else if (env.RESEND_FROM_DOMAIN) from = `auth@${env.RESEND_FROM_DOMAIN}`;
		else {
			console.warn(
				"[email] No EMAIL_FROM or RESEND_FROM_DOMAIN configured — skipping send",
			);
			return;
		}
	}

	if (scheduledAt && provider.name !== "resend") {
		console.warn(
			`[email] scheduledAt requested but provider is ${provider.name} — sending immediately`,
		);
	}

	return provider.send({
		from,
		to: test ? "delivered@resend.dev" : email,
		subject,
		react,
		scheduledAt: provider.name === "resend" ? scheduledAt : undefined,
		cc: test ? undefined : cc,
		replyTo,
	});
};
