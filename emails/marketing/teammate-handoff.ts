import type { EmailDefinition } from "../types";

export const teammateHandoff = {
	id: "teammate-handoff",
	key: "handoff",
	purpose: "Help a teammate share useful context with their organization.",
	subject: "Make your next handoff easier",
	previewText: "Show your teammate the bit that's hard to put into words.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>Next time you hand something over to a teammate, try recording the part that's tricky to explain in a message.</Paragraph>",
		"<Paragraph>Show what changed and what you need them to look at. Even a short recording can save a lot of back and forth.</Paragraph>",
		`<Paragraph><Link href="https://cap.so/dashboard">Open your team workspace</Link>. Before sending a recording, check its sharing settings so the right people can watch it.</Paragraph>`,
		"<Paragraph>If anything about sharing with your team feels awkward, reply and let me know.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
