import type { EmailDefinition } from "../types";

export const freeShare = {
	id: "free-share",
	key: "share",
	purpose: "Offer sharing guidance when no shared cloud video is known.",
	subject: "Send your next explanation as a Cap",
	previewText: "A short recording and one sentence are enough.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>Next time you're typing a long explanation, try showing it in Cap instead.</Paragraph>",
		"<Paragraph>Record the bit that's hard to explain, then send the link with a sentence about what you need. Something like: “Here's the bug I mentioned. Can you see the same thing?”</Paragraph>",
		"<Paragraph>It doesn't have to be polished to be useful.</Paragraph>",
		'<Paragraph><Link href="https://cap.so/dashboard">Open your Cap library</Link>.</Paragraph>',
	].join(""),
} satisfies EmailDefinition;
