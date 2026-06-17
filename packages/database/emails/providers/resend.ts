import { Resend } from "resend";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "./types";

export class ResendEmailProvider implements EmailProvider {
	readonly name = "resend" as const;
	private readonly client: Resend;

	constructor(apiKey: string) {
		this.client = new Resend(apiKey);
	}

	async send(input: SendEmailInput): Promise<SendEmailResult> {
		const result = await this.client.emails.send({
			from: input.from,
			to: input.to,
			subject: input.subject,
			react: input.react,
			cc: input.cc,
			replyTo: input.replyTo,
			scheduledAt: input.scheduledAt,
		});

		if (result.error) {
			console.error(
				`[email] Resend send failed: ${result.error.name} — ${result.error.message}`,
			);
			return {};
		}

		return { id: result.data?.id };
	}
}
