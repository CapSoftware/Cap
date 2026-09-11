import type { EmailDefinition } from "../types";

export const customerWelcome = {
	id: "customer-welcome",
	key: "welcome",
	purpose: "Welcome a paying customer with copy matching their paid plan.",
	subject: "Thanks for choosing {contact.capPlanName}",
	previewText: "Thanks for backing what we're building.",
	variables: ["capCustomerWelcome", "capPlanName", "capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>Richie here, founder of Cap. Thanks so much for supporting what we're building. It means a lot.</Paragraph>",
		"<Paragraph>{contact.capCustomerWelcome}</Paragraph>",
		"<Paragraph>What are you planning to use Cap for? Just reply and let me know. I'd love to hear.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
