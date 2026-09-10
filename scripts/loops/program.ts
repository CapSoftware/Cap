export const programVersion = "cap-lifecycle-v1";

export const contactProperties = {
	capAudience: "string",
	capOrigin: "string",
	capConsent: "string",
	capTeammate: "boolean",
	capCustomer: "boolean",
	capPlanName: "string",
	capCustomerWelcome: "string",
	capPromotionalEligible: "boolean",
	capOnboardingEligible: "boolean",
	capLifecycleEnabled: "boolean",
	capLifecycleStage: "string",
	capHasVideo: "boolean",
	capHasSharedVideo: "boolean",
	capVerifiedAt: "date",
	capImportedAt: "date",
	capSignupAt: "date",
	capSourceTags: "string",
	capSourceGroup: "string",
} as const;

export type Condition = {
	type: "property";
	key: string;
	operator: "equals" | "isTrue" | "isFalse";
	value?: string;
};

export const condition = (key: string, value: string | boolean): Condition =>
	typeof value === "boolean"
		? { type: "property", key, operator: value ? "isTrue" : "isFalse" }
		: { type: "property", key, operator: "equals", value };

export const audienceFilter = (audience: string, promotional: boolean) => ({
	match: "all" as const,
	conditions: [
		condition("subscribed", true),
		condition("capConsent", "subscribed"),
		condition("capAudience", audience),
		...(promotional
			? [
					condition("capTeammate", false),
					condition("capPromotionalEligible", true),
				]
			: []),
	],
});

export const theme = {
	name: "Cap lifecycle v1",
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
		name: "Cap lifecycle header v1",
		lmx: '<Paragraph fontSize="20" paddingBottom="24"><Strong><Link href="https://cap.so">Cap</Link></Strong></Paragraph>',
	},
	{
		name: "Cap lifecycle signature v1",
		lmx: '<Paragraph paddingTop="16">Richie<Br />Founder, Cap</Paragraph>',
	},
];

type Message = {
	key: string;
	delayDays: number;
	subject: string;
	previewText: string;
	body: string;
	onlyIf?: { property: string; value: boolean };
};

type Journey = {
	key: string;
	name: string;
	audience: string;
	promotional: boolean;
	messages: Message[];
};

export const journeys: Journey[] = [
	{
		key: "free",
		name: "Cap | Independent free-user onboarding",
		audience: "free",
		promotional: true,
		messages: [
			{
				key: "welcome",
				delayDays: 0,
				subject: "Your first Cap can be a small one",
				previewText: "Pick one thing you would usually explain in a message.",
				body: '<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>Thanks for trying Cap. A good first recording is something small: a quick explanation, a bug you spotted, or feedback on a piece of work.</Paragraph><Paragraph><Strong>Pick one thing you would normally type out, and record it instead.</Strong> Use Instant Mode for a shareable link, or Studio Mode when you want to edit before exporting.</Paragraph><Button href="https://cap.so/download" align="left" paddingTop="16" paddingBottom="16">Download Cap</Button><Paragraph>If you get stuck, reply to this email. We can help.</Paragraph>',
			},
			{
				key: "record",
				delayDays: 2,
				subject: "Try a 30-second recording",
				previewText: "A simple way to get comfortable with Cap.",
				onlyIf: { property: "capHasVideo", value: false },
				body: '<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>Here is an easy way to try Cap: open something you are working on and explain one small part of it out loud.</Paragraph><Paragraph>Choose your screen or a single window, check your microphone, and record for about 30 seconds. No script needed.</Paragraph><Paragraph>If you prefer to keep the recording on your device, use Studio Mode and export it locally.</Paragraph><Button href="https://cap.so/download" align="left" paddingTop="16" paddingBottom="16">Open the downloads page</Button><Paragraph>Already recording locally? You are all set. Local recordings do not necessarily appear in your cloud library.</Paragraph>',
			},
			{
				key: "share",
				delayDays: 3,
				subject: "Give your next Cap a little context",
				previewText: "Help the person watching know what to look for.",
				onlyIf: { property: "capHasSharedVideo", value: false },
				body: '<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>A recording works best when the person watching knows why you sent it.</Paragraph><Paragraph>Give your Cap a clear title, then send the link with one sentence about what you need: feedback, a decision, or just a quick look.</Paragraph><Paragraph>For a bug report, show what you expected and what happened. For feedback, point to the specific part you want to discuss.</Paragraph><Button href="https://cap.so/dashboard" align="left" paddingTop="16" paddingBottom="16">Open your library</Button>',
			},
			{
				key: "plans",
				delayDays: 4,
				subject: "Choose the Cap setup that fits your work",
				previewText: "A desktop license and Cap Pro solve different needs.",
				body: '<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>If the free version covers what you need, keep using it.</Paragraph><Paragraph>If you use Cap for work, a <Strong>Desktop License</Strong> covers commercial use of the desktop recorder and editor. <Strong>Cap Pro</Strong> adds the cloud sharing and collaboration features, and includes the desktop commercial license.</Paragraph><Paragraph>The plans page has the current features and prices, so you can choose based on how you actually use Cap.</Paragraph><Button href="https://cap.so/pricing" align="left" paddingTop="16" paddingBottom="16">Compare Cap plans</Button><Paragraph>Unsure which one fits? Reply with how you use Cap and we will point you in the right direction.</Paragraph>',
			},
		],
	},
	{
		key: "customer",
		name: "Cap | Customer onboarding",
		audience: "customer",
		promotional: false,
		messages: [
			{
				key: "welcome",
				delayDays: 0,
				subject: "Thanks for choosing {contact.capPlanName}",
				previewText: "A few useful things to do first.",
				body: '<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>Thank you for supporting Cap.</Paragraph><Paragraph>{contact.capCustomerWelcome}</Paragraph><Paragraph>Start with one recording you need to make this week. A walkthrough, a customer explanation, or feedback for a colleague is plenty.</Paragraph><Button href="https://cap.so/download" align="left" paddingTop="16" paddingBottom="16">Get Cap</Button><Paragraph>If anything about your setup or access looks wrong, reply and we will help you sort it out.</Paragraph>',
			},
			{
				key: "workflow",
				delayDays: 3,
				subject: "One explanation you can reuse",
				previewText: "Turn a recurring question into a short recording.",
				body: "<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>One of the most useful things to record is an answer you keep giving.</Paragraph><Paragraph>Pick a recurring question, record a short walkthrough, and give it a title you will recognize later. Trim the beginning and end if you need to, then export or share it in the way that suits your work.</Paragraph><Paragraph>The next time the question comes up, you already have the answer ready.</Paragraph><Paragraph>If you have a workflow you would like Cap to make easier, reply and tell us about it.</Paragraph>",
			},
			{
				key: "feedback",
				delayDays: 4,
				subject: "How is Cap working for you?",
				previewText: "Tell us what is useful and what gets in the way.",
				body: "<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>How has Cap been working for you?</Paragraph><Paragraph>I would love to know what you have been using it for, and whether anything has been confusing or frustrating.</Paragraph><Paragraph>Just reply to this email. Specific examples help us decide what to improve next.</Paragraph><Paragraph>Thanks again for supporting what we are building.</Paragraph>",
			},
		],
	},
	{
		key: "teammate",
		name: "Cap | Teammate onboarding",
		audience: "teammate",
		promotional: false,
		messages: [
			{
				key: "welcome",
				delayDays: 0,
				subject: "Getting started with your team in Cap",
				previewText: "Find your workspace and make your first handoff easier.",
				body: '<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>Welcome to your team in Cap.</Paragraph><Paragraph>Open your dashboard and make sure the right organization is selected. That is where you will find the recordings your team shares with you.</Paragraph><Paragraph>If something is missing, check with the person who invited you. They can confirm your workspace and access.</Paragraph><Button href="https://cap.so/dashboard" align="left" paddingTop="16" paddingBottom="16">Open your workspace</Button><Paragraph>You can also reply here if you need help getting set up.</Paragraph>',
			},
			{
				key: "handoff",
				delayDays: 3,
				subject: "Make your next handoff easier",
				previewText:
					"A short recording can give your teammate the context they need.",
				body: '<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>For your next handoff, try recording the bit that is difficult to explain in writing.</Paragraph><Paragraph>Show the work, explain what changed, and say what you need from the person watching. A clear title and a short note beside the link make it easier to pick up later.</Paragraph><Paragraph>When sharing, check that the recording is available to the right people in your organization.</Paragraph><Button href="https://cap.so/dashboard" align="left" paddingTop="16" paddingBottom="16">Open your workspace</Button><Paragraph>If the team workflow feels awkward anywhere, reply and let us know.</Paragraph>',
			},
		],
	},
	{
		key: "former",
		name: "Cap | Former customer follow-up",
		audience: "former",
		promotional: true,
		messages: [
			{
				key: "feedback",
				delayDays: 14,
				subject: "What could we have done better?",
				previewText: "A quick question about your experience with Cap.",
				body: "<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>Now that your paid access has ended, I wanted to ask what could have made Cap more useful for you.</Paragraph><Paragraph>Was there something missing, something that did not work properly, or did you just not need it anymore?</Paragraph><Paragraph>Reply if you have a moment. Honest feedback helps us make better decisions.</Paragraph><Paragraph>Thanks for giving Cap a try.</Paragraph>",
			},
		],
	},
];

export const campaignTemplates = [
	{
		key: "customer-update",
		name: "Cap | Customer product update template",
		audience: "customer",
		promotional: false,
		subject: "What is new in Cap",
		previewText: "See the latest improvements in the changelog.",
		body: '<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>We have been working on improvements to Cap. You can find the latest changes and fixes in the changelog.</Paragraph><Button href="https://cap.so/changelog" align="left" paddingTop="16" paddingBottom="16">Read the changelog</Button><Paragraph>If something would make Cap more useful for you, reply and tell us.</Paragraph>',
	},
	{
		key: "free-update",
		name: "Cap | Noncustomer product update template",
		audience: "free",
		promotional: true,
		subject: "Take another look at Cap",
		previewText: "Catch up on the latest changes.",
		body: '<Paragraph>Hi {contact.firstName},</Paragraph><Paragraph>If you have not tried Cap recently, the changelog is a good place to see what has changed.</Paragraph><Paragraph>Download the latest version when you have a recording to make. You can start small and see whether it fits how you work.</Paragraph><Button href="https://cap.so/changelog" align="left" paddingTop="16" paddingBottom="16">See what is new</Button>',
	},
];
