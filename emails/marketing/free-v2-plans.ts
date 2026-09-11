import type { EmailDefinition } from "../types";

export const freeV2Plans = {
	id: "free-v2-plans",
	key: "plans",
	purpose:
		"Offer Pro to active free users through a specific cloud-sharing benefit.",
	subject: "Some explanations need more than five minutes",
	previewText: "Share the full walkthrough with Cap Pro.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>Five minutes works for a quick question. A full walkthrough sometimes needs longer.</Paragraph>",
		"<Paragraph><Strong>Cap Pro</Strong> removes the five-minute limit on cloud recordings and gives you unlimited shareable links, so you can send the whole explanation in one video.</Paragraph>",
		"<Paragraph>It also includes the desktop commercial license for work recordings.</Paragraph>",
		"<Paragraph>Pro is US$12 per user, billed monthly. Annual billing is also available.</Paragraph>",
		'<Paragraph><Link href="https://cap.so/login?next=%2Fdashboard%2Fsettings%2Forganization%2Fbilling%3Futm_source%3Dloops%26utm_medium%3Demail%26utm_campaign%3Dfree-pro-v2%26utm_content%3Dplans">Upgrade to Cap Pro</Link></Paragraph>',
	].join(""),
} satisfies EmailDefinition;
