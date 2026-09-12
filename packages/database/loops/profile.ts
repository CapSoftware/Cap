import { createHash } from "node:crypto";
export type CustomerCopy = Record<
	"pro" | "selfhosted" | "desktop" | "other",
	{ plan: string; welcome: string }
>;

export type Consent = "subscribed" | "unsubscribed" | "suppressed" | "unknown";
export type CapUser = {
	id: string;
	email: string;
	name: string | null;
	lastName: string | null;
	stripeSubscriptionStatus: string | null;
	thirdPartyStripeSubscriptionId: string | null;
	created_at: string;
	defaultOrgId: string | null;
	marketingOrigin?: string;
};
export type Membership = {
	userId: string;
	organizationId: string;
	ownerId: string;
	hasProSeat: number | boolean;
	tombstoneAt: string | null;
	workosConnectionId: string | null;
	createdAt: string;
};
export type License = {
	email: string;
	subscriptionActive: number | boolean;
	nextRenewalDate: string | null;
	kind: "desktop" | "selfhosted";
};
export type SourceContact = Record<string, string> & { email: string };
export type ProfileInput = {
	source: SourceContact;
	user?: CapUser;
	memberships: Membership[];
	licenses: License[];
	invited: boolean;
	sso: boolean;
	teammateLatch?: boolean;
	hasVideo: boolean;
	hasSharedVideo: boolean;
	now: Date;
};

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const emailHash = (email: string) =>
	createHash("sha256").update(normalizeEmail(email)).digest("hex");

export function isoDate(value: string) {
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}( UTC)?$/.test(value)
		? `${value.replace(" UTC", "").replace(" ", "T")}Z`
		: value;
	const date = new Date(normalized);
	if (!Number.isFinite(date.getTime()))
		throw new Error("Source contains an invalid date");
	return date.toISOString();
}

export function sourceConsent(source: SourceContact): Consent {
	if (source.flag?.trim()) return "suppressed";
	if (source.unsubscribed_at?.trim()) {
		return /bounce|spam|invalid|blocked|undeliver|complaint/i.test(
			source.unsubscribed_reason ?? "",
		)
			? "suppressed"
			: "unsubscribed";
	}
	if (["false", "0", "no"].includes(source.subscribed?.trim().toLowerCase()))
		return "unsubscribed";
	return "subscribed";
}

export function classifyProfile(
	input: ProfileInput,
	customerCopy: CustomerCopy,
) {
	const { source, user, licenses, memberships, now } = input;
	const consent = sourceConsent(source);
	const teammate = Boolean(
		input.teammateLatch ||
			input.invited ||
			input.sso ||
			user?.marketingOrigin === "teammate" ||
			user?.thirdPartyStripeSubscriptionId ||
			memberships.some(
				(member) => member.ownerId !== user?.id || member.workosConnectionId,
			),
	);
	const directCustomer = [
		"active",
		"trialing",
		"complete",
		"paid",
		"past_due",
	].includes(user?.stripeSubscriptionStatus ?? "");
	const activeLicenses = licenses.filter(
		(license) =>
			Boolean(license.subscriptionActive) &&
			license.nextRenewalDate !== null &&
			Date.parse(isoDate(license.nextRenewalDate)) > now.getTime(),
	);
	const customer =
		directCustomer ||
		activeLicenses.length > 0 ||
		Boolean(user?.thirdPartyStripeSubscriptionId) ||
		memberships.some(
			(member) => !member.tombstoneAt && Boolean(member.hasProSeat),
		);
	const historicalIndependent =
		user &&
		memberships.some(
			(member) =>
				!member.tombstoneAt &&
				member.ownerId === user.id &&
				member.organizationId === user.defaultOrgId &&
				Math.abs(
					Date.parse(isoDate(member.createdAt)) -
						Date.parse(isoDate(user.created_at)),
				) <
					5 * 60_000,
		);
	const independent =
		user?.marketingOrigin === "independent" || historicalIndependent;
	const historicalCustomer =
		/(^|[,;|\s])customer([,;|\s]|$)/i.test(source.tags ?? "") ||
		licenses.length > 0;
	const former =
		user?.stripeSubscriptionStatus === "canceled" && licenses.length === 0;
	const audience = teammate
		? "teammate"
		: customer
			? "customer"
			: former
				? "former"
				: independent && !historicalCustomer && !user?.stripeSubscriptionStatus
					? "free"
					: "unknown";
	const copy =
		customerCopy[
			directCustomer
				? "pro"
				: activeLicenses.some((license) => license.kind === "selfhosted")
					? "selfhosted"
					: activeLicenses.length
						? "desktop"
						: "other"
		];
	const firstName =
		[source.first_name, source.firstname, user?.name?.trim().split(/\s+/)[0]]
			.map((value) => value?.trim())
			.find((value) => value && value.toLowerCase() !== "null") ?? "";
	return {
		email: normalizeEmail(source.email),
		userId: user?.id ?? `bento:${emailHash(source.email)}`,
		firstName,
		capGreeting: firstName ? `Hey ${firstName},` : "Hey,",
		lastName:
			[source.last_name, source.lastname, user?.lastName]
				.map((value) => value?.trim())
				.find((value) => value && value !== "null") ?? "",
		subscribed: consent === "subscribed",
		source: "Bento migration",
		capAudience: audience,
		capOrigin: teammate ? "teammate" : independent ? "independent" : "unknown",
		capConsent: consent,
		capTeammate: teammate,
		capCustomer: customer,
		capPlanName: copy.plan,
		capCustomerWelcome: copy.welcome,
		capPromotionalEligible:
			consent === "subscribed" &&
			!teammate &&
			(audience === "free" || audience === "former"),
		capOnboardingEligible: false,
		capLifecycleEnabled: false,
		capLifecycleStage: "idle",
		capHasVideo: input.hasVideo,
		capHasSharedVideo: input.hasSharedVideo,
		capVerifiedAt: now.toISOString(),
		capImportedAt: now.toISOString(),
		capSignupAt: isoDate(
			user?.created_at || source.created_at || now.toISOString(),
		),
		capSourceTags: source.tags || "",
		capSourceGroup: source.userGroup || source.usergroup || "",
	};
}

export type ContactProfile = ReturnType<typeof classifyProfile>;
