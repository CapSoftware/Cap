import type { EmailDefinition } from "../types";

export const freeV2Welcome = {
	id: "free-v2-welcome",
	key: "welcome",
	purpose:
		"Help a new independent free user record and share one useful explanation.",
	subject: "Your first Cap only needs 30 seconds",
	previewText: "Record one thing, send the link, and you're off.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>Richie here, founder of Cap. Thanks for giving it a go :)</Paragraph>",
		"<Paragraph>For your first recording, pick something you'd normally explain in a long message. Open Cap, choose <Strong>Instant Mode</Strong>, and spend 30 seconds showing it on screen.</Paragraph>",
		"<Paragraph>Once it's ready, send the link to someone who needs that explanation. No polished presentation needed.</Paragraph>",
		'<Paragraph><Link href="https://cap.so/download?utm_source=loops&amp;utm_medium=email&amp;utm_campaign=free-pro-v2&amp;utm_content=welcome">Download Cap and make your first recording</Link></Paragraph>',
		"<Paragraph>If you get stuck, reply here and I'll help.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
