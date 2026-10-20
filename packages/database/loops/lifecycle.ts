import {
	activationSignalsAfter,
	freeOnboardingExperiment,
	freeOnboardingVariant,
	inFreeExperiment,
} from "./experiment";
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
	capFreeOnboardingVariant?: string;
	capFreeOnboardingExperiment?: string;
	capFreeOnboardingAssignedAt?: string;
};

export type LoopsRuntimeConfig = {
	listId: string;
	enrollmentAfter: Date;
	enrollmentEnabled: boolean;
	allowedEmails: Set<string> | null;
	teammateJoinedAt?: string | null;
	freeExperimentAfter?: Date;
	freeExperimentEnrollmentEnabled?: boolean;
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

export function activationFollowUps(input: LoopsProfileSource["input"]) {
	const recentlyNotified = Boolean(
		input.lastActivationNotificationAt &&
			input.now.getTime() -
				Date.parse(isoDate(input.lastActivationNotificationAt)) <
				24 * 60 * 60_000,
	);
	const ready = input.hasVideo && !input.hasPendingUpload && !recentlyNotified;
	return {
		capReadyForPro: ready,
		capNeedsSharingHelp: ready && !input.hasSharedVideo,
		capNeedsRecordingHelp: !input.hasVideo && !recentlyNotified,
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
	const assigned =
		remote.capFreeOnboardingExperiment === freeOnboardingExperiment;
	const canAssign =
		config.freeExperimentEnrollmentEnabled === true &&
		eligible &&
		audience === "free" &&
		!teammate &&
		!remote.capFreeOnboardingExperiment &&
		(!remote.capLifecycleStage || remote.capLifecycleStage === "idle") &&
		inFreeExperiment(profile.capSignupAt, config.freeExperimentAfter);
	const assignment = canAssign
		? {
				capFreeOnboardingVariant: freeOnboardingVariant(profile.userId),
				capFreeOnboardingExperiment: freeOnboardingExperiment,
				capFreeOnboardingAssignedAt: source.input.now.toISOString(),
			}
		: {};
	const variant = canAssign
		? assignment.capFreeOnboardingVariant
		: assigned
			? remote.capFreeOnboardingVariant
			: undefined;
	if (
		assigned &&
		(!["control", "pro-v2"].includes(remote.capFreeOnboardingVariant ?? "") ||
			!Number.isFinite(Date.parse(remote.capFreeOnboardingAssignedAt ?? "")))
	)
		throw new Error("invalid_free_experiment_assignment");
	return {
		...attributes,
		...(inFreeExperiment(profile.capSignupAt, activationSignalsAfter)
			? activationFollowUps(source.input)
			: {}),
		...assignment,
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
		capLifecycleStage: eligible
			? audience === "free" && variant === "pro-v2"
				? "free-v2"
				: audience
			: "idle",
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
