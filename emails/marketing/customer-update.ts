import type { EmailDefinition } from "../types";

export const customerUpdate = {
	id: "customer-update",
	key: "customer-update",
	purpose: "Reusable product update for customers.",
	subject: "What is new in Cap",
	previewText: "See the latest improvements in the changelog.",
	variables: ["firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>We have been working on improvements to Cap. You can find the latest changes and fixes in the changelog.</Paragraph>",
		'<Button href="https://cap.so/changelog" align="left" paddingTop="16" paddingBottom="16">Read the changelog</Button>',
		"<Paragraph>If something would make Cap more useful for you, reply and tell us.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
