import type { EmailDefinition } from "../types";

export const customerCaseStudy = {
	id: "customer-case-study",
	key: "customer-case-study",
	purpose:
		"Invite named Cap Pro organisation owners with more than one seat to reply if they'd like their team on the website logo wall, in a case study, or both.",
	subject: "Could we feature your team on the Cap website?",
	previewText:
		"A spot on our new logo wall, and a case study if you're up for it.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>We're adding a logo wall to the Cap website to show the teams using Cap, and I'd love to include yours.</Paragraph>",
		"<Paragraph>We're also putting together case studies, and it'd be great to feature your team in one of those too.</Paragraph>",
		"<Paragraph>If you're enjoying Cap and would like to be featured, just reply and let me know if you're happy to be on the logo wall, do a case study, or both. For a case study, I'll send you a short Q&amp;A to fill in.</Paragraph>",
		"<Paragraph>It'd really help Cap move into the next stage of our growth, and help us tell other great teams like yours all about Cap.</Paragraph>",
		"<Paragraph>Thanks so much for supporting us :)</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
