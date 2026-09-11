import type { EmailDefinition } from "../types";

export const formerFeedback = {
	id: "former-feedback",
	key: "feedback",
	purpose:
		"Ask an eligible former cloud customer for feedback after paid access ends.",
	subject: "What could we have done better?",
	previewText: "A quick question about your experience with Cap.",
	variables: ["firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>Now that your paid access has ended, I wanted to ask what could have made Cap more useful for you.</Paragraph>",
		"<Paragraph>Was there something missing, something that did not work properly, or did you just not need it anymore?</Paragraph>",
		"<Paragraph>Reply if you have a moment. Honest feedback helps us make better decisions.</Paragraph>",
		"<Paragraph>Thanks for giving Cap a try.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
