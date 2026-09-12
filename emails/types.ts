import type { contactFallbacks } from "./brand";

export type Audience = "free" | "customer" | "teammate" | "former";
export type EmailDefinition = {
	id: string;
	key: string;
	purpose: string;
	subject: string;
	previewText: string;
	body: string;
	variables: (keyof typeof contactFallbacks)[];
};
export type Message = EmailDefinition & {
	delayDays: number;
	onlyIf?: { property: string; value: boolean };
};
export type Journey = {
	key: string;
	name: string;
	audience: Audience;
	promotional: boolean;
	messages: Message[];
};
export type Campaign = EmailDefinition & {
	name: string;
	audience: Audience;
	promotional: boolean;
};
