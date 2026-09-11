import type { EmailDefinition } from "../types";

export const customerWelcome = {
	id: "customer-welcome",
	key: "welcome",
	purpose: "Welcome a paying customer with copy matching their paid plan.",
	subject: "Thanks for choosing {contact.capPlanName}",
	previewText: "A few useful things to do first.",
	variables: ["capCustomerWelcome", "capPlanName", "firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>Thank you for supporting Cap.</Paragraph>",
		"<Paragraph>{contact.capCustomerWelcome}</Paragraph>",
		"<Paragraph>Start with one recording you need to make this week. A walkthrough, a customer explanation, or feedback for a colleague is plenty.</Paragraph>",
		'<Button href="https://cap.so/download" align="left" paddingTop="16" paddingBottom="16">Get Cap</Button>',
		"<Paragraph>If anything about your setup or access looks wrong, reply and we will help you sort it out.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
