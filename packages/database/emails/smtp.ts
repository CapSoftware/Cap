import { serverEnv } from "@cap/env";
import { render } from "@react-email/render";
import { createTransport } from "nodemailer";
import type { JSXElementConstructor, ReactElement } from "react";

export type SmtpSendResult =
	| { data: { id: string }; error: null }
	| { data: null; error: { name: string; message: string } };

const smtpErrorName = (error: unknown) =>
	error instanceof Error && "code" in error && typeof error.code === "string"
		? error.code
		: "smtp_error";

export async function sendViaSmtp({
	host,
	from,
	to,
	subject,
	react,
	cc,
	replyTo,
	attachments,
}: {
	host: string;
	from: string;
	to: string;
	subject: string;
	react: ReactElement<unknown, string | JSXElementConstructor<unknown>>;
	cc?: string | string[];
	replyTo?: string;
	attachments?: {
		filename: string;
		content: Buffer | string;
		contentType?: string;
	}[];
}): Promise<SmtpSendResult> {
	const env = serverEnv();
	const secure = env.SMTP_SECURE ?? env.SMTP_PORT === 465;
	const auth =
		env.SMTP_USER && env.SMTP_PASSWORD
			? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
			: undefined;

	// nodemailer defaults to a 2 minute connect and 10 minute socket timeout,
	// which would hang login and invite requests on an unreachable server.
	const transporter = createTransport({
		host,
		port: env.SMTP_PORT,
		secure,
		requireTLS: !secure && auth !== undefined,
		auth,
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 30_000,
	});

	const html = await render(react);
	const text = await render(react, { plainText: true });

	try {
		const info = await transporter.sendMail({
			from,
			to,
			cc,
			replyTo,
			subject,
			html,
			text,
			attachments,
		});
		return { data: { id: info.messageId }, error: null };
	} catch (error) {
		return {
			data: null,
			error: {
				name: smtpErrorName(error),
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}
