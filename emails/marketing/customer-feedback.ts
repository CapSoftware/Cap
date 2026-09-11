import type { EmailDefinition } from "../types";

export const customerFeedback = {
	id: "customer-feedback",
	key: "feedback",
	purpose: "Ask a customer what is useful and what needs improvement.",
	subject: "How is Cap working for you?",
	previewText: "Tell us what is useful and what gets in the way.",
	variables: ["firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>How has Cap been working for you?</Paragraph>",
		"<Paragraph>I would love to know what you have been using it for, and whether anything has been confusing or frustrating.</Paragraph>",
		"<Paragraph>Just reply to this email. Specific examples help us decide what to improve next.</Paragraph>",
		"<Paragraph>Thanks again for supporting what we are building.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
