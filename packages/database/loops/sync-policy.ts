import { createHash } from "node:crypto";
import type { Consent, ContactProfile } from "./profile";

export type RemoteContact = {
	id: string;
	email: string;
	userId: string | null;
	subscribed: boolean;
	mailingLists: Record<string, boolean>;
	capTeammate?: boolean;
	capLifecycleStage?: string;
	capOnboardingEligible?: boolean;
};

export const mergeConsent = (existing: Consent, incoming: Consent): Consent => {
	if (existing === "suppressed" || incoming === "suppressed")
		return "suppressed";
	if (existing === "unsubscribed" || incoming === "unsubscribed")
		return "unsubscribed";
	return existing === "subscribed" || incoming === "subscribed"
		? "subscribed"
		: "unknown";
};

export function profileFingerprint(profile: ContactProfile) {
	const {
		capVerifiedAt: _verified,
		capImportedAt: _imported,
		...stable
	} = profile;
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function contactUpdate(
	profile: ContactProfile,
	remote: RemoteContact,
	listId?: string,
) {
	if (
		remote.userId &&
		remote.userId !== profile.userId &&
		!profile.userId.startsWith("bento:")
	)
		throw new Error("Contact identity conflict");
	const {
		subscribed: _subscribed,
		capImportedAt: _imported,
		source: _source,
		...attributes
	} = profile;
	const allowed =
		profile.capConsent === "subscribed" &&
		remote.subscribed &&
		(!listId || remote.mailingLists[listId] === true);
	const teammate = profile.capTeammate || remote.capTeammate === true;
	return {
		...attributes,
		...(remote.userId && profile.userId.startsWith("bento:")
			? { userId: remote.userId }
			: {}),
		capTeammate: teammate,
		capAudience: teammate ? "teammate" : profile.capAudience,
		capPromotionalEligible:
			allowed && !teammate && profile.capPromotionalEligible,
		capOnboardingEligible: allowed && profile.capOnboardingEligible,
		capLifecycleEnabled: allowed && profile.capLifecycleEnabled,
		...(!allowed ? { capLifecycleStage: "idle" } : {}),
		...(profile.capConsent !== "subscribed" ? { subscribed: false } : {}),
	};
}

export function importContactUpdate(
	profile: ContactProfile,
	remote: RemoteContact,
	listId?: string,
) {
	return contactUpdate(profile, remote, listId);
}
