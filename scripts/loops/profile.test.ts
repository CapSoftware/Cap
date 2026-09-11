import assert from "node:assert/strict";
import { test } from "node:test";
import {
	classifyProfile,
	emailHash,
	isoDate,
	type ProfileInput,
	sourceConsent,
} from "./profile";
import { audienceFilter, journeys } from "./program";
import {
	contactUpdate,
	importContactUpdate,
	mergeConsent,
	profileFingerprint,
	type RemoteContact,
} from "./sync-policy";

const input = (): ProfileInput => ({
	source: {
		email: "person@example.com",
		created_at: "2026-01-01 12:00:00 UTC",
	},
	user: {
		id: "cap-user",
		email: "person@example.com",
		name: "Taylor",
		lastName: null,
		stripeSubscriptionStatus: null,
		thirdPartyStripeSubscriptionId: null,
		created_at: "2026-01-01T12:00:00.000Z",
		defaultOrgId: "personal",
	},
	memberships: [
		{
			userId: "cap-user",
			organizationId: "personal",
			ownerId: "cap-user",
			hasProSeat: false,
			tombstoneAt: null,
			workosConnectionId: null,
			createdAt: "2026-01-01T12:00:00.000Z",
		},
	],
	licenses: [],
	invited: false,
	sso: false,
	hasVideo: false,
	hasSharedVideo: false,
	now: new Date("2026-09-10T12:00:00.000Z"),
});
const remote = (): RemoteContact => ({
	id: "loops-id",
	email: "person@example.com",
	userId: "cap-user",
	subscribed: true,
	mailingLists: { tips: true },
});

test("greetings include a name only when a nonblank name is known", () => {
	const fixture = input();
	assert.equal(classifyProfile(fixture).capGreeting, "Hey Taylor,");
	fixture.source.first_name = "  Sam  ";
	assert.equal(classifyProfile(fixture).capGreeting, "Hey Sam,");
	fixture.user = undefined;
	for (const firstName of [undefined, "", "   ", "null", "NULL"]) {
		fixture.source.first_name = firstName;
		assert.equal(classifyProfile(fixture).capGreeting, "Hey,");
	}
});

test("an explicit source opt-out always wins over a positive custom flag", () => {
	assert.equal(
		sourceConsent({
			email: "p@example.com",
			unsubscribed_at: "2026-01-01",
			subscribed: "true",
		}),
		"unsubscribed",
	);
	assert.equal(
		sourceConsent({ email: "p@example.com", subscribed: "false" }),
		"unsubscribed",
	);
	assert.equal(
		sourceConsent({ email: "p@example.com", flag: "blocked" }),
		"suppressed",
	);
	assert.equal(
		sourceConsent({
			email: "p@example.com",
			unsubscribed_at: "2026-01-01",
			unsubscribed_reason: "hard_bounce",
		}),
		"suppressed",
	);
});

test("opt-out registry merges cannot resubscribe or clear a suppression", () => {
	for (const status of [
		"unknown",
		"subscribed",
		"unsubscribed",
		"suppressed",
	] as const) {
		assert.equal(mergeConsent("suppressed", status), "suppressed");
		assert.notEqual(mergeConsent("unsubscribed", status), "subscribed");
	}
});

test("email hashes ignore case and surrounding whitespace", () => {
	assert.equal(
		emailHash(" Person@Example.com "),
		emailHash("person@example.com"),
	);
});

test("historical Bento and MySQL dates become unambiguous API dates", () => {
	assert.equal(isoDate("2024-04-22 13:29:55 UTC"), "2024-04-22T13:29:55.000Z");
	assert.equal(isoDate("2024-04-22 13:29:55"), "2024-04-22T13:29:55.000Z");
	assert.throws(() => isoDate("not-a-date"));
});

test("verified independent free users are eligible but imported onboarding remains held", () => {
	const profile = classifyProfile(input());
	assert.equal(profile.capAudience, "free");
	assert.equal(profile.capPromotionalEligible, true);
	assert.equal(profile.capLifecycleEnabled, false);
	assert.equal(profile.capOnboardingEligible, false);
	assert.equal(profile.capLifecycleStage, "idle");
});

for (const status of ["active", "trialing", "complete", "paid", "past_due"]) {
	test(`${status} direct subscribers never enter the free promotion audience`, () => {
		const value = input();
		if (!value.user) throw new Error("Missing fixture user");
		value.user.stripeSubscriptionStatus = status;
		const profile = classifyProfile(value);
		assert.equal(profile.capAudience, "customer");
		assert.equal(profile.capPromotionalEligible, false);
	});
}

test("a desktop license prevents Pro upsell onboarding even with no cloud subscription", () => {
	const value = input();
	value.licenses = [
		{
			email: value.source.email,
			subscriptionActive: 1,
			nextRenewalDate: "2038-01-01T00:00:00.000Z",
			kind: "desktop",
		},
	];
	assert.equal(classifyProfile(value).capAudience, "customer");
	assert.equal(classifyProfile(value).capPlanName, "Cap Desktop");
	value.licenses[0].nextRenewalDate = "2025-01-01T00:00:00.000Z";
	assert.equal(classifyProfile(value).capAudience, "unknown");
});

for (const kind of [
	"membership",
	"invite",
	"sso",
	"latch",
	"origin",
	"seat",
] as const) {
	test(`${kind} teammate evidence excludes promotions`, () => {
		const value = input();
		if (!value.user) throw new Error("Missing fixture user");
		if (kind === "membership")
			value.memberships.push({
				...value.memberships[0],
				organizationId: "team",
				ownerId: "someone-else",
			});
		if (kind === "invite") value.invited = true;
		if (kind === "sso") value.sso = true;
		if (kind === "latch") value.teammateLatch = true;
		if (kind === "origin") value.user.marketingOrigin = "teammate";
		if (kind === "seat") value.user.thirdPartyStripeSubscriptionId = "sub_team";
		const profile = classifyProfile(value);
		assert.equal(profile.capAudience, "teammate");
		assert.equal(profile.capPromotionalEligible, false);
	});
}

test("unknown origin and historic customer tags fail closed", () => {
	const value = input();
	value.memberships = [];
	assert.equal(classifyProfile(value).capAudience, "unknown");
	const customer = input();
	customer.source.tags = "customer";
	assert.equal(classifyProfile(customer).capAudience, "unknown");
});

test("canceled cloud access can enter former audience but an active license overrides it", () => {
	const value = input();
	if (!value.user) throw new Error("Missing fixture user");
	value.user.stripeSubscriptionStatus = "canceled";
	assert.equal(classifyProfile(value).capAudience, "former");
	value.licenses = [
		{
			email: value.source.email,
			subscriptionActive: 1,
			nextRenewalDate: "2038-01-01T00:00:00.000Z",
			kind: "desktop",
		},
	];
	assert.equal(classifyProfile(value).capAudience, "customer");
});

test("sync never supplies subscribed true or replaces list subscriptions", () => {
	const profile = classifyProfile(input());
	for (const contact of [
		remote(),
		{ ...remote(), subscribed: false },
		{ ...remote(), mailingLists: {} },
	]) {
		const update = contactUpdate(profile, contact, "tips");
		assert.equal("subscribed" in update, false);
		assert.equal("mailingLists" in update, false);
		if (!contact.subscribed || !contact.mailingLists.tips)
			assert.equal(update.capPromotionalEligible, false);
	}
	profile.capConsent = "unsubscribed";
	assert.equal(contactUpdate(profile, remote(), "tips").subscribed, false);
});

test("existing teammate evidence and identities survive contact enrichment", () => {
	const profile = classifyProfile(input());
	const update = contactUpdate(
		profile,
		{ ...remote(), capTeammate: true },
		"tips",
	);
	assert.equal(update.capAudience, "teammate");
	assert.equal(update.capPromotionalEligible, false);
	assert.throws(() =>
		contactUpdate(profile, { ...remote(), userId: "another-cap-user" }, "tips"),
	);
	profile.userId = `bento:${emailHash(profile.email)}`;
	assert.equal(contactUpdate(profile, remote(), "tips").userId, "cap-user");
});

test("migration joins a new list without overwriting any explicit preference", () => {
	const profile = classifyProfile(input());
	const update = importContactUpdate(profile, remote(), "new-list");
	assert.deepEqual("mailingLists" in update && update.mailingLists, {
		"new-list": true,
	});
	assert.equal(update.capPromotionalEligible, true);
	assert.equal(update.capLifecycleEnabled, false);
	assert.equal("subscribed" in update, false);
	for (const contact of [
		{ ...remote(), subscribed: false },
		{ ...remote(), mailingLists: { "new-list": false } },
	]) {
		const held = importContactUpdate(profile, contact, "new-list");
		assert.equal("mailingLists" in held, false);
		assert.equal("subscribed" in held, false);
		assert.equal(held.capPromotionalEligible, false);
	}
});

test("verification timestamps do not churn the sync fingerprint", () => {
	const profile = classifyProfile(input());
	assert.equal(
		profileFingerprint(profile),
		profileFingerprint({
			...profile,
			capVerifiedAt: "later",
			capImportedAt: "later",
		}),
	);
	assert.notEqual(
		profileFingerprint(profile),
		profileFingerprint({ ...profile, capTeammate: true }),
	);
});

test("every journey requires subscription consent and promotional journeys exclude teammates", () => {
	assert.equal(
		journeys.reduce((count, journey) => count + journey.messages.length, 0),
		10,
	);
	for (const journey of journeys) {
		const filter = audienceFilter(journey.audience, journey.promotional);
		assert.ok(
			filter.conditions.some(
				(condition) =>
					condition.key === "subscribed" && condition.operator === "isTrue",
			),
		);
		assert.ok(
			filter.conditions.some(
				(condition) =>
					condition.key === "capConsent" && condition.value === "subscribed",
			),
		);
		if (journey.promotional)
			assert.ok(
				filter.conditions.some(
					(condition) =>
						condition.key === "capTeammate" && condition.operator === "isFalse",
				),
			);
	}
});
