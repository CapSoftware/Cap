export const brandingVersion = 6;

export const deliveryFormat: "mjml" | "lmx" = "mjml";

export const bodyLineHeightPercent = 160;

export const logo = {
	src: "https://images.vialoops.com/cmtvpmjen01ks0j18ebmp77uk/img/cmtwz64ty00qx0j0poxsc4u7x.png",
	file: "emails/assets/cap-logo.png",
	width: 120,
	borderRadius: 0,
};

export const signature = ["Cheers,", "Richie"];

export const footer = {
	company: "Cap Software, Inc.",
	address: "1111B S Governors Ave, Dover, DE 19904, United States",
	unsubscribeLabel: "Unsubscribe",
};

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
		textBaseLineHeight: bodyLineHeightPercent,
		textLinkColor: "#3159d6",
		heading1Color: "#171717",
		heading1FontSize: 26,
		heading1LineHeight: 130,
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
		lmx: `<Image src="${logo.src}" alt="Cap" width="${logo.width}" borderRadius="${logo.borderRadius}" paddingBottom="24" />`,
	},
	{
		name: `Cap lifecycle signature v${brandingVersion}`,
		lmx: `<Paragraph lineHeight="${bodyLineHeightPercent}" paddingTop="8">${signature.join("<Br />")}</Paragraph>`,
	},
];

export const sender = {
	fromName: "Richie from Cap",
	fromEmail: "richie",
	replyToEmail: "richie@cap.so",
	emailFormat: "styled",
};

export const contactFallbacks = {
	capGreeting: "Hey,",
	capPlanName: "Cap",
	capCustomerWelcome:
		"If you need a hand getting set up, just reply and I'll help you sort it.",
};

export type BrandIds = { theme: string; header: string; signature: string };

export const paragraphSpacing = 16;

export const emailContent = (
	message: { subject: string; previewText: string; body: string },
	ids: BrandIds,
) => ({
	subject: message.subject,
	previewText: message.previewText,
	...sender,
	lmx: `<Style themeId="${ids.theme}" />\n<Component componentId="${ids.header}" />\n${message.body.replaceAll("<Paragraph>", `<Paragraph lineHeight="${bodyLineHeightPercent}" paddingBottom="${paragraphSpacing}">`)}\n<Component componentId="${ids.signature}" />`,
	contactPropertiesFallbacks: contactFallbacks,
});
