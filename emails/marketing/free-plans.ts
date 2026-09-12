import type { EmailDefinition } from "../types";

export const freePlans = {
	id: "free-plans",
	key: "plans",
	purpose: "Explain current plan options to eligible independent noncustomers.",
	subject: "Using Cap for work?",
	previewText: "Here's how the Desktop License and Cap Pro compare.",
	variables: ["capGreeting"],
	body: [
		"<Paragraph>{contact.capGreeting}</Paragraph>",
		"<Paragraph>If you're thinking about using Cap for work, there are two options.</Paragraph>",
		"<Paragraph>A <Strong>Desktop License</Strong> covers commercial use of the recorder and editor. It's a good fit if you mainly edit and export videos yourself.</Paragraph>",
		"<Paragraph><Strong>Cap Pro</Strong> adds cloud sharing and collaboration, and includes the desktop commercial license. That's the one to look at if you're sharing recordings with clients or your team.</Paragraph>",
		`<Paragraph><Link href="https://cap.so/pricing">Compare the plans here</Link>.</Paragraph>`,
		"<Paragraph>Not sure which you need? Reply with what you're using Cap for and I'll point you in the right direction.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
