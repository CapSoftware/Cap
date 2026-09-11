import type { EmailDefinition } from "../types";

export const customerWorkflow = {
	id: "customer-workflow",
	key: "workflow",
	purpose: "Help a customer build a repeatable recording habit.",
	subject: "One explanation you can reuse",
	previewText: "Turn a recurring question into a short recording.",
	variables: ["firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>One of the most useful things to record is an answer you keep giving.</Paragraph>",
		"<Paragraph>Pick a recurring question, record a short walkthrough, and give it a title you will recognize later. Trim the beginning and end if you need to, then export or share it in the way that suits your work.</Paragraph>",
		"<Paragraph>The next time the question comes up, you already have the answer ready.</Paragraph>",
		"<Paragraph>If you have a workflow you would like Cap to make easier, reply and tell us about it.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
