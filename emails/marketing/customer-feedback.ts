import type { EmailDefinition } from "../types";

export const customerFeedback = {
	id: "customer-feedback",
	key: "feedback",
	purpose: "Ask a customer what is useful and what needs improvement.",
	subject: "How is Cap working for you?",
	previewText: "I'd love to hear what's working and what isn't.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>How are you getting on with Cap?</Paragraph>",
		"<Paragraph>I'd love to know if there's anything you wish worked differently, or something that's getting in your way.</Paragraph>",
		"<Paragraph>Just reply here. I read every reply, and hearing how people actually use Cap helps me decide what we should work on next.</Paragraph>",
		"<Paragraph>Thanks again for backing us :)</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
