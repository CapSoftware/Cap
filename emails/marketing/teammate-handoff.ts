import type { EmailDefinition } from "../types";

export const teammateHandoff = {
	id: "teammate-handoff",
	key: "handoff",
	purpose: "Help a teammate share useful context with their organization.",
	subject: "Make your next handoff easier",
	previewText:
		"A short recording can give your teammate the context they need.",
	variables: ["firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>For your next handoff, try recording the bit that is difficult to explain in writing.</Paragraph>",
		"<Paragraph>Show the work, explain what changed, and say what you need from the person watching. A clear title and a short note beside the link make it easier to pick up later.</Paragraph>",
		"<Paragraph>When sharing, check that the recording is available to the right people in your organization.</Paragraph>",
		'<Button href="https://cap.so/dashboard" align="left" paddingTop="16" paddingBottom="16">Open your workspace</Button>',
		"<Paragraph>If the team workflow feels awkward anywhere, reply and let us know.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
