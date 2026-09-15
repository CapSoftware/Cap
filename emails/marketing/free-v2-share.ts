import type { EmailDefinition } from "../types";

export const freeV2Share = {
	id: "free-v2-share",
	key: "share",
	purpose:
		"Help an active user put a completed recording into a real conversation.",
	subject: "Put your recording to work",
	previewText: "Send the link with one sentence about what you need.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>A useful way to share a Cap is to add one sentence telling the other person what you need from them.</Paragraph>",
		"<Paragraph>\"Here's the bit I'm stuck on. Can you take a look?\"</Paragraph>",
		'<Paragraph>Or: "Here\'s how to change that setting. Does that solve it?"</Paragraph>',
		'<Paragraph><Link href="https://cap.so/login?next=%2Fdashboard%2Fcaps%3Futm_source%3Dloops%26utm_medium%3Demail%26utm_campaign%3Dfree-pro-v2%26utm_content%3Dshare">Open your recordings</Link></Paragraph>',
		"<Paragraph>Send the link wherever you're already having the conversation.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
