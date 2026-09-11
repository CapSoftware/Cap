import type { EmailDefinition } from "../types";

export const customerWorkflow = {
	id: "customer-workflow",
	key: "workflow",
	purpose: "Help a customer build a repeatable recording habit.",
	subject: "One less thing to explain twice",
	previewText: "A recording you can keep coming back to.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>A quick idea for your next recording: pick a question you keep answering and record the walkthrough once.</Paragraph>",
		"<Paragraph>It could be how to set something up, where to find a setting, or how you want a piece of work done. Give it a title you'll recognise later, then save or share it wherever you normally answer that question.</Paragraph>",
		"<Paragraph>The next time someone asks, you've already got it ready.</Paragraph>",
		"<Paragraph>Anything making that harder than it should be? Reply and tell me.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
