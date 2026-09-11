import {
	type ContactProfile,
	type CustomerCopy,
	classifyProfile,
	isoDate,
} from "./profile";
import type { LoopsProfileSource } from "./sources";
import type { RemoteContact } from "./sync-policy";

export type LifecycleContact = RemoteContact & {
	capImportedAt?: string;
	capConsent?: string;
	capLifecycleEnabled?: boolean;
	capSignupAt?: string;
};

export type LoopsRuntimeConfig = {
	listId: string;
	enrollmentAfter: Date;
	enrollmentEnabled: boolean;
	allowedEmails: Set<string> | null;
	teammateJoinedAt?: string | null;
};

export function enrollmentWindow(signupAt: string, config: LoopsRuntimeConfig) {
	return {
		recentSignup:
			config.enrollmentEnabled &&
			Date.parse(signupAt) >= config.enrollmentAfter.getTime(),
		recentJoin:
			config.enrollmentEnabled &&
			Boolean(config.teammateJoinedAt) &&
			Date.parse(isoDate(config.teammateJoinedAt ?? "")) >=
				config.enrollmentAfter.getTime(),
	};
}

export function lifecycleUpdate(
	source: LoopsProfileSource,
	remote: LifecycleContact,
	config: LoopsRuntimeConfig,
	customerCopy: CustomerCopy,
) {
	const profile = classifyProfile(source.input, customerCopy);
	if (
		remote.userId &&
		remote.userId !== profile.userId &&
		!remote.userId.startsWith("bento:")
	)
		throw new Error("identity_conflict");
	const teammate = profile.capTeammate || remote.capTeammate === true;
	const audience = teammate ? "teammate" : profile.capAudience;
	const globallySubscribed =
		remote.subscribed &&
		!["unsubscribed", "suppressed"].includes(remote.capConsent ?? "");
	const subscribed =
		globallySubscribed && remote.mailingLists[config.listId] === true;
	const enrollment = enrollmentWindow(profile.capSignupAt, config);
	const imported = Boolean(remote.capImportedAt);
	const eligible =
		config.enrollmentEnabled &&
		source.signedUp &&
		subscribed &&
		!source.pendingInvite &&
		((!imported && enrollment.recentSignup) ||
			(teammate && enrollment.recentJoin)) &&
		audience !== "unknown";
	const {
		subscribed: _subscribed,
		capImportedAt: _imported,
		source: _source,
		capSourceTags: _tags,
		capSourceGroup: _group,
		...attributes
	} = profile;
	return {
		...attributes,
		capTeammate: teammate,
		capAudience: audience,
		capOrigin: teammate ? "teammate" : profile.capOrigin,
		capConsent: globallySubscribed
			? "subscribed"
			: remote.capConsent === "suppressed"
				? "suppressed"
				: "unsubscribed",
		capPromotionalEligible:
			subscribed && !teammate && profile.capPromotionalEligible,
		capLifecycleEnabled: eligible,
		capOnboardingEligible: eligible,
		capLifecycleStage: eligible ? audience : "idle",
	};
}

export function nextProfileCheck(
	profile: Pick<ContactProfile, "capSignupAt">,
	now: Date,
) {
	const age = now.getTime() - Date.parse(isoDate(profile.capSignupAt));
	return new Date(
		now.getTime() +
			(age < 16 * 24 * 60 * 60_000 ? 60 * 60_000 : 24 * 60 * 60_000),
	);
}

export function retryDelay(failures: number) {
	return Math.min(60 * 60_000, 30_000 * 2 ** Math.min(failures, 7));
}
