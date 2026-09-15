import type { EmailDefinition } from "../types";

export const teammateWelcome = {
	id: "teammate-welcome",
	key: "welcome",
	purpose:
		"Help an invited teammate find their workspace without promoting upgrades.",
	subject: "Welcome to your team in Cap",
	previewText: "Here's where to find your team's recordings.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>Richie here, founder of Cap. Great to have you with us :)</Paragraph>",
		"<Paragraph><Link href=\"https://cap.so/dashboard\">Open your dashboard</Link> and select your team's organisation. You'll find the recordings they've shared with you there.</Paragraph>",
		"<Paragraph>If you can't see the right organisation, check with the person who invited you. They can confirm which email address they used and your access.</Paragraph>",
		"<Paragraph>You can also reply here if you need a hand.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
