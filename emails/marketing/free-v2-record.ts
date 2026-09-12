import type { EmailDefinition } from "../types";

export const freeV2Record = {
	id: "free-v2-record",
	key: "record",
	purpose:
		"Offer a small first cloud recording task when no completed video is visible.",
	subject: "One small thing to record today",
	previewText: "Try explaining something you already know.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>If you're still finding your feet with Cap, try recording a quick walkthrough of something you already know: a setting, a page, or a problem you want to show someone.</Paragraph>",
		"<Paragraph>Choose <Strong>Instant Mode</Strong>, keep it short, then send the link when it's ready.</Paragraph>",
		'<Paragraph><Link href="https://cap.so/download?utm_source=loops&amp;utm_medium=email&amp;utm_campaign=free-pro-v2&amp;utm_content=record">Get started with your first recording</Link></Paragraph>',
		"<Paragraph>If screen or microphone permissions are getting in the way, reply with what you're seeing and I'll help you sort it.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
