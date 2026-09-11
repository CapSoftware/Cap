import type { EmailDefinition } from "../types";

export const freeUpdate = {
	id: "free-update",
	key: "free-update",
	purpose: "Reusable product update for eligible independent noncustomers.",
	subject: "Take another look at Cap",
	previewText: "Catch up on the latest changes.",
	variables: ["firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>If you have not tried Cap recently, the changelog is a good place to see what has changed.</Paragraph>",
		"<Paragraph>Download the latest version when you have a recording to make. You can start small and see whether it fits how you work.</Paragraph>",
		'<Button href="https://cap.so/changelog" align="left" paddingTop="16" paddingBottom="16">See what is new</Button>',
	].join(""),
} satisfies EmailDefinition;
