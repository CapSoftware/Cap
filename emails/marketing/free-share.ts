import type { EmailDefinition } from "../types";

export const freeShare = {
	id: "free-share",
	key: "share",
	purpose: "Offer sharing guidance when no shared cloud video is known.",
	subject: "Give your next Cap a little context",
	previewText: "Help the person watching know what to look for.",
	variables: ["firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>A recording works best when the person watching knows why you sent it.</Paragraph>",
		"<Paragraph>Give your Cap a clear title, then send the link with one sentence about what you need: feedback, a decision, or just a quick look.</Paragraph>",
		"<Paragraph>For a bug report, show what you expected and what happened. For feedback, point to the specific part you want to discuss.</Paragraph>",
		'<Button href="https://cap.so/dashboard" align="left" paddingTop="16" paddingBottom="16">Open your library</Button>',
	].join(""),
} satisfies EmailDefinition;
