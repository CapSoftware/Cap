export const contactProperties = {
	capGreeting: "string",
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
