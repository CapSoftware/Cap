import type { EmailDefinition } from "../types";

export const freeWelcome = {
	id: "free-welcome",
	key: "welcome",
	purpose: "Help an independent free user make their first recording.",
	subject: "Your first Cap can be a small one",
	previewText: "Pick one thing you would usually explain in a message.",
	variables: ["firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>Thanks for trying Cap. A good first recording is something small: a quick explanation, a bug you spotted, or feedback on a piece of work.</Paragraph>",
		"<Paragraph><Strong>Pick one thing you would normally type out, and record it instead.</Strong> Use Instant Mode for a shareable link, or Studio Mode when you want to edit before exporting.</Paragraph>",
		'<Button href="https://cap.so/download" align="left" paddingTop="16" paddingBottom="16">Download Cap</Button>',
		"<Paragraph>If you get stuck, reply to this email. We can help.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
