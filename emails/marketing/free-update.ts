import type { EmailDefinition } from "../types";

export const freeUpdate = {
	id: "free-update",
	key: "free-update",
	purpose:
		"Evergreen reactivation invitation for eligible independent noncustomers; review before each campaign.",
	subject: "Take another look at Cap",
	previewText: "Was something missing when you tried it?",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>If it's been a while since you tried Cap, I'd love for you to take another look.</Paragraph>",
		'<Paragraph><Link href="https://cap.so/changelog">You can see what\'s changed here</Link>. Next time you need to explain something on screen, give it a go.</Paragraph>',
		"<Paragraph>If something put you off last time, just reply and tell me. I'd like to know, especially if it was something we could have done better.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
