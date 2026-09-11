import type { EmailDefinition } from "../types";

export const freeRecord = {
	id: "free-record",
	key: "record",
	purpose: "Offer recording help when no cloud video is known.",
	subject: "Try a 30-second recording",
	previewText: "A simple way to get comfortable with Cap.",
	variables: ["firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>Here is an easy way to try Cap: open something you are working on and explain one small part of it out loud.</Paragraph>",
		"<Paragraph>Choose your screen or a single window, check your microphone, and record for about 30 seconds. No script needed.</Paragraph>",
		"<Paragraph>If you prefer to keep the recording on your device, use Studio Mode and export it locally.</Paragraph>",
		'<Button href="https://cap.so/download" align="left" paddingTop="16" paddingBottom="16">Open the downloads page</Button>',
		"<Paragraph>Already recording locally? You are all set. Local recordings do not necessarily appear in your cloud library.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
