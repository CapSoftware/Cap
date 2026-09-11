import type { EmailDefinition } from "../types";

export const freeWelcome = {
	id: "free-welcome",
	key: "welcome",
	purpose: "Help an independent free user make their first recording.",
	subject: "Welcome to Cap",
	previewText: "Richie here. Great to have you with us :)",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>Richie here, founder of Cap. Thanks for giving it a go :)</Paragraph>",
		"<Paragraph>The easiest way to start is to record something you'd normally type out. A quick explanation or a bit of feedback is plenty.</Paragraph>",
		"<Paragraph>Use Instant Mode when you want a shareable link, or Studio Mode to edit your recording and export it locally.</Paragraph>",
		'<Paragraph><Link href="https://cap.so/download">Download Cap here</Link>.</Paragraph>',
		"<Paragraph>If you have any questions, just reply to this email. I'd love to help.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
