import type { EmailDefinition } from "../types";

export const customerUpdate = {
	id: "customer-update",
	key: "customer-update",
	purpose:
		"Evergreen changelog invitation for customers; review before each campaign.",
	subject: "Keeping up with Cap",
	previewText: "The changes we've shipped, all in one place.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>Just a quick one from me. If you're wondering what's changed in Cap, we keep the features and fixes together in our changelog.</Paragraph>",
		"<Paragraph><Link href=\"https://cap.so/changelog\">Here's what we've shipped</Link>.</Paragraph>",
		"<Paragraph>Is there something you're still waiting for us to build or fix? Reply and let me know. Hearing what's missing is just as useful as hearing what's working.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
