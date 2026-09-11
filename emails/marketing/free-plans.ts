import type { EmailDefinition } from "../types";

export const freePlans = {
	id: "free-plans",
	key: "plans",
	purpose: "Explain current plan options to eligible independent noncustomers.",
	subject: "Choose the Cap setup that fits your work",
	previewText: "A desktop license and Cap Pro solve different needs.",
	variables: ["firstName"],
	body: [
		"<Paragraph>Hi {contact.firstName},</Paragraph>",
		"<Paragraph>If the free version covers what you need, keep using it.</Paragraph>",
		"<Paragraph>If you use Cap for work, a <Strong>Desktop License</Strong> covers commercial use of the desktop recorder and editor. <Strong>Cap Pro</Strong> adds the cloud sharing and collaboration features, and includes the desktop commercial license.</Paragraph>",
		"<Paragraph>The plans page has the current features and prices, so you can choose based on how you actually use Cap.</Paragraph>",
		'<Button href="https://cap.so/pricing" align="left" paddingTop="16" paddingBottom="16">Compare Cap plans</Button>',
		"<Paragraph>Unsure which one fits? Reply with how you use Cap and we will point you in the right direction.</Paragraph>",
	].join(""),
} satisfies EmailDefinition;
