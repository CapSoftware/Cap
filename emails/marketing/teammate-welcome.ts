import type { EmailDefinition } from "../types";

export const teammateWelcome = {
	id: "teammate-welcome",
	key: "welcome",
	purpose:
		"Help an invited teammate find their workspace without promoting upgrades.",
	subject: "Getting started with your team in Cap",
	previewText: "Find your workspace and make your first handoff easier.",
	variables: ["firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>Welcome to your team in Cap.</Paragraph>",
		"<Paragraph>Open your dashboard and make sure the right organization is selected. That is where you will find the recordings your team shares with you.</Paragraph>",
		"<Paragraph>If something is missing, check with the person who invited you. They can confirm your workspace and access.</Paragraph>",
		'<Button href="https://cap.so/dashboard" align="left" paddingTop="16" paddingBottom="16">Open your workspace</Button>',
		"<Paragraph>You can also reply here if you need help getting set up.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
