import type { EmailDefinition } from "../types";

export const customerCaseStudy = {
	id: "customer-case-study",
	key: "customer-case-study",
	purpose:
		"Invite Cap Pro organisation owners with more than one seat to reply if they'd like their team featured in a website case study.",
	subject: "Could we feature your team in a Cap case study?",
	previewText: "Reply and I'll send over a short Q&A.",
	variables: ["capTeamGreeting"],
	body: [
		"<Paragraph>{contact.capTeamGreeting}</Paragraph>",
		"<Paragraph>We're putting together case studies for the Cap website, and I'd love to feature your team in one.</Paragraph>",
		"<Paragraph>If you're enjoying Cap and would like to be involved, just reply to this email and I'll send you a short Q&amp;A to fill in.</Paragraph>",
		"<Paragraph>It'd really help Cap move into the next stage of our growth, and help us tell other great teams like yours all about Cap.</Paragraph>",
		"<Paragraph>Thanks so much for supporting us :)</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
