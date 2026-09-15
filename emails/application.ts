export type ApplicationEmail = {
	id: string;
	name: string;
	trigger: string;
	recipients: string;
	notes: string;
	template: string;
	sources: string[];
};

export const applicationEmails: ApplicationEmail[] = [
	{
		id: "verification-code",
		name: "Login verification code",
		trigger: "Web or mobile email authentication request",
		recipients: "The person signing in",
		notes: "OTP authentication; does not subscribe the recipient to marketing.",
		template: "otp-email",
		sources: [
			"packages/database/auth/auth-options.ts",
			"apps/web/app/api/mobile/[...route]/route.ts",
		],
	},
	{
		id: "organization-invite",
		name: "Organization invitation",
		trigger:
			"An organization invitation is issued through the web action or public API",
		recipients: "The invited teammate",
		notes: "An invitation is not permission to send promotions.",
		template: "organization-invite",
		sources: [
			"apps/web/actions/organization/send-invites.ts",
			"apps/web/app/api/v1/[...route]/route.ts",
		],
	},
	{
		id: "download-link",
		name: "Requested download links",
		trigger: "The person requests download links by email",
		recipients: "The requesting email address",
		notes:
			"Uses the existing Resend marketing sender flag; Loops audience filters do not govern this send.",
		template: "download-link",
		sources: ["apps/web/actions/send-download-link.ts"],
	},
	{
		id: "first-shareable-link",
		name: "First shareable recording",
		trigger: "Desktop API creates the first eligible shareable recording",
		recipients: "The recording owner",
		notes:
			"Scheduled in Resend for five minutes later; uses the existing marketing sender flag. Check overlap before activating Loops recording reminders.",
		template: "first-shareable-link",
		sources: ["apps/web/app/api/desktop/[...route]/video.ts"],
	},
	{
		id: "new-comment",
		name: "New comment notification",
		trigger: "An eligible comment notification is created",
		recipients: "The notification recipient",
		notes:
			"Notification preferences and exclusions are applied by Notification.ts.",
		template: "new-comment",
		sources: ["apps/web/lib/Notification.ts"],
	},
	{
		id: "first-view",
		name: "First view notification",
		trigger: "An eligible recording receives its first view",
		recipients: "The recording owner",
		notes:
			"Notification preferences and first-view checks are applied by Notification.ts.",
		template: "first-view",
		sources: ["apps/web/lib/Notification.ts"],
	},
	{
		id: "payment-failed",
		name: "Payment failed / final retry",
		trigger: "Stripe invoice payment fails",
		recipients: "The billing account user",
		notes:
			"Different subject and content for the final attempt; deduplicated by invoice and attempt.",
		template: "payment-failed",
		sources: ["apps/web/app/api/webhooks/stripe/route.ts"],
	},
	{
		id: "signed-baa",
		name: "Signed BAA delivery",
		trigger: "A business associate agreement is signed",
		recipients: "The signer, with the configured notice recipients copied",
		notes:
			"Includes the signed PDF and tracks delivery state; preserve attachment and CC behavior.",
		template: "signed-baa",
		sources: ["apps/web/actions/organization/signed-baa.ts"],
	},
	{
		id: "desktop-feedback",
		name: "Desktop feedback notification",
		trigger: "Legacy desktop feedback handler",
		recipients: "Cap support, with the user copied",
		notes:
			"Source-defined handler; inspect route reachability before relying on it.",
		template: "feedback",
		sources: ["apps/web/app/api/desktop/[...route]/root.ts"],
	},
	{
		id: "messenger-support",
		name: "Messenger support notification",
		trigger: "An eligible support conversation requests an email notification",
		recipients: "Cap support; replies go to the user",
		notes: "The support service reserves notification state before sending.",
		template: "messenger-support-email",
		sources: ["apps/web/lib/messenger/support-email.ts"],
	},
	{
		id: "account-deletion",
		name: "Account deletion request notification",
		trigger: "An account deletion request is submitted",
		recipients: "Cap support; replies go to the requester",
		notes: "Deduplicated by deletion request ID.",
		template: "messenger-support-email",
		sources: ["apps/web/lib/account-deletion-request.ts"],
	},
	{
		id: "content-report",
		name: "Mobile content report notification",
		trigger: "A mobile content report is submitted",
		recipients: "Cap support; replies go to the reporter",
		notes: "Deduplicated by report ID.",
		template: "messenger-support-email",
		sources: ["apps/web/lib/account-deletion-request.ts"],
	},
	{
		id: "login-link",
		name: "Legacy login link template",
		trigger: "No current send call found in this checkout",
		recipients: "None configured",
		notes:
			"Retained source template; current email login uses verification codes.",
		template: "login-link",
		sources: [],
	},
];
