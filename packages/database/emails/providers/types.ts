import type { JSXElementConstructor, ReactElement } from "react";

export type EmailProviderName = "resend" | "smtp";

export type SendEmailInput = {
	from: string;
	to: string;
	subject: string;
	react: ReactElement<unknown, string | JSXElementConstructor<unknown>>;
	cc?: string | string[];
	replyTo?: string;
	scheduledAt?: string;
};

export type SendEmailResult = {
	id?: string;
};

export interface EmailProvider {
	readonly name: EmailProviderName;
	send(input: SendEmailInput): Promise<SendEmailResult>;
}
