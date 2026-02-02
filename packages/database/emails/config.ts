import { buildEnv, serverEnv } from "@cap/env";
import type { JSXElementConstructor, ReactElement } from "react";
import { Resend } from "resend";

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
	react: ReactElement<any, string | JSXElementConstructor<any>>;
	marketing?: boolean;
	test?: boolean;
	scheduledAt?: string;
	cc?: string | string[];
	replyTo?: string;
	fromOverride?: string;
}) => {
	const r = resend();
	if (!r) {
		return Promise.resolve();
	}

	if (marketing && !buildEnv.NEXT_PUBLIC_IS_CAP) return;
	let from;

	if (fromOverride) from = fromOverride;
	else if (marketing) from = "Richie from Cap <richie@send.cap.so>";
	else if (buildEnv.NEXT_PUBLIC_IS_CAP)
		from = "Cap Auth <no-reply@auth.cap.so>";
	else from = `auth@${serverEnv().RESEND_FROM_DOMAIN}`;

	return r.emails.send({
		from,
		to: test ? "delivered@resend.dev" : email,
		subject,
		react,
		scheduledAt,
		cc: test ? undefined : cc,
		replyTo: replyTo,
	}) as any;
};
