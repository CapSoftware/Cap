import type { EmailDefinition } from "../types";

export const freeV2Ai = {
	id: "free-v2-ai",
	key: "ai",
	purpose:
		"Show active free users how Pro reduces the work around a recording.",
	subject: "Record the walkthrough. Skip the extra write-up.",
	previewText: "Give people a summary and chapters alongside your video.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>A recording saves you typing everything out. Writing a summary afterwards can feel like doing the job twice.</Paragraph>",
		"<Paragraph><Strong>Cap Pro</Strong> generates a title, summary, transcript and clickable chapters for your recordings. The person watching can get the context, then jump to the part they need.</Paragraph>",
		"<Paragraph>That's especially useful for walkthroughs people come back to later.</Paragraph>",
		'<Paragraph><Link href="https://cap.so/login?next=%2Fdashboard%2Fsettings%2Forganization%2Fbilling%3Futm_source%3Dloops%26utm_medium%3Demail%26utm_campaign%3Dfree-pro-v2%26utm_content%3Dai">See Cap Pro</Link></Paragraph>',
	].join(""),
} satisfies EmailDefinition;
