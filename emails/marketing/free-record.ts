import type { EmailDefinition } from "../types";

export const freeRecord = {
	id: "free-record",
	key: "record",
	purpose: "Offer recording help when no cloud video is known.",
	subject: "A quick way to try Cap",
	previewText: "You don't need a script or a perfect take.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>If you're still finding your feet with Cap, try this: open something on your screen and spend 30 seconds explaining it out loud.</Paragraph>",
		"<Paragraph>No script or perfect take needed. In Studio Mode, you can trim it afterwards and keep the recording on your own device.</Paragraph>",
		`<Paragraph>Need the app? <Link href="https://cap.so/download">You can download Cap here</Link>.</Paragraph>`,
		"<Paragraph>If something's stopping you from recording, reply and let me know what happened. I'll help you sort it.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
