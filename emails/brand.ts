export const brandingVersion = 1;

export const theme = {
	name: `Cap lifecycle v${brandingVersion}`,
	styles: {
		backgroundColor: "#ffffff",
		bodyColor: "#ffffff",
		bodyXPadding: 28,
		bodyYPadding: 28,
		bodyFontFamily: "Helvetica",
		bodyFontCategory: "sans-serif",
		textBaseColor: "#252525",
		textBaseFontSize: 16,
		textBaseLineHeight: 26,
		textLinkColor: "#3159d6",
		heading1Color: "#171717",
		heading1FontSize: 26,
		heading1LineHeight: 34,
		heading2FontSize: 21,
		buttonBodyColor: "#3159d6",
		buttonTextColor: "#ffffff",
		buttonTextFontSize: 16,
		buttonBorderRadius: 8,
		buttonBodyXPadding: 18,
		buttonBodyYPadding: 12,
	},
};

export const components = [
	{
		name: `Cap lifecycle header v${brandingVersion}`,
		lmx: '<Paragraph fontSize="20" paddingBottom="24"><Strong><Link href="https://cap.so">Cap</Link></Strong></Paragraph>',
	},
	{
		name: `Cap lifecycle signature v${brandingVersion}`,
		lmx: '<Paragraph paddingTop="16">Richie<Br />Founder, Cap</Paragraph>',
	},
];

export const sender = {
	fromName: "Richie from Cap",
	fromEmail: "richie",
	replyToEmail: "richie@cap.so",
	emailFormat: "styled",
};

export const contactFallbacks = {
	firstName: "there",
	capPlanName: "Cap",
	capCustomerWelcome:
		"Your paid access is ready. If you need help getting started, reply to this email.",
};

export type BrandIds = { theme: string; header: string; signature: string };

export const emailContent = (
	message: { subject: string; previewText: string; body: string },
	ids: BrandIds,
) => ({
	subject: message.subject,
	previewText: message.previewText,
	...sender,
	lmx: `<Style themeId="${ids.theme}" />\n<Component componentId="${ids.header}" />\n${message.body}\n<Component componentId="${ids.signature}" />`,
	contactPropertiesFallbacks: contactFallbacks,
});
