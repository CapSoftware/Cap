import type { EmailDefinition } from "../types";

export const formerFeedback = {
	id: "former-feedback",
	key: "feedback",
	purpose:
		"Ask an eligible former cloud customer for feedback after paid access ends.",
	subject: "Could I ask about your time with Cap?",
	previewText: "I'd appreciate your honest feedback.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>Could I ask what made you decide to stop using your paid Cap plan?</Paragraph>",
		"<Paragraph>Was something missing, did something not work properly, or did you just not need it anymore?</Paragraph>",
		"<Paragraph>If you've got a moment to reply, I'd really appreciate it. And if there was a problem I can help with, I'd like to try.</Paragraph>",
		"<Paragraph>Thanks for giving Cap a go.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
