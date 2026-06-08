import { render } from "@react-email/render";
import type { Transporter } from "nodemailer";
import { createTransport } from "nodemailer";
import type {
	EmailProvider,
	SendEmailInput,
	SendEmailResult,
} from "./types";

export type SmtpConfig = {
	host: string;
	port: number;
	secure: boolean;
	user?: string;
	pass?: string;
};

export class SmtpEmailProvider implements EmailProvider {
	readonly name = "smtp" as const;
	private readonly transporter: Transporter;

	constructor(config: SmtpConfig) {
		this.transporter = createTransport({
			host: config.host,
			port: config.port,
			secure: config.secure,
			auth:
				config.user && config.pass
					? { user: config.user, pass: config.pass }
					: undefined,
		});
	}

	async send(input: SendEmailInput): Promise<SendEmailResult> {
		if (input.scheduledAt) {
			throw new Error(
				"SMTP provider does not support scheduled sends. Use Resend for scheduledAt.",
			);
		}

		const [html, text] = await Promise.all([
			render(input.react),
			render(input.react, { plainText: true }),
		]);

		const info = await this.transporter.sendMail({
			from: input.from,
			to: input.to,
			cc: input.cc,
			replyTo: input.replyTo,
			subject: input.subject,
			html,
			text,
		});

		return { id: info.messageId };
	}
}
