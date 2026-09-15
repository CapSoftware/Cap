import type { EmailDefinition } from "../types";

export const freeV2Help = {
	id: "free-v2-help",
	key: "help",
	purpose:
		"Invite a reply from users who have not reached a completed cloud recording.",
	subject: "Anything getting in the way?",
	previewText: "Reply and tell me where you're getting stuck.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>If you haven't found a useful way to fit Cap into your day yet, is anything getting in the way?</Paragraph>",
		"<Paragraph>Maybe you're not sure what to record, something isn't working, or it isn't quite what you expected.</Paragraph>",
		"<Paragraph>Reply and let me know. If I can help you get a useful first recording out of it, I'd like to.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
