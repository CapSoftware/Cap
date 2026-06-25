import { buildEnv } from "@cap/env";

const activeSubscriptionStatuses = new Set([
	"active",
	"trialing",
	"complete",
	"paid",
]);

export type ProSeatProvider = {
	id: string;
	inviteQuota?: number | null;
	stripeSubscriptionId?: string | null;
	stripeSubscriptionStatus?: string | null;
};

export function hasActiveDirectSubscription(
	provider: ProSeatProvider | null | undefined,
) {
	return (
		!!provider?.stripeSubscriptionId &&
		!!provider.stripeSubscriptionStatus &&
		activeSubscriptionStatuses.has(provider.stripeSubscriptionStatus)
	);
}

export function selectProSeatProvider<T extends ProSeatProvider>({
	actor,
	owner,
	actorCanManageProSeats,
}: {
	actor?: T | null;
	owner?: T | null;
	actorCanManageProSeats: boolean;
}) {
	const candidates = [
		actorCanManageProSeats && hasActiveDirectSubscription(actor) ? actor : null,
		hasActiveDirectSubscription(owner) ? owner : null,
	].filter((provider): provider is T => !!provider);

	return (
		candidates.sort((a, b) => (b.inviteQuota ?? 1) - (a.inviteQuota ?? 1))[0] ??
		owner ??
		(actorCanManageProSeats ? actor : null) ??
		null
	);
}

export function calculateProSeats(organization: {
	inviteQuota?: number;
	ownerId?: string | null;
	ownerIsPro?: boolean;
	members?: { id: string; userId?: string | null; hasProSeat?: boolean }[];
}) {
	const proSeatsTotal = organization?.inviteQuota ?? 1;
	const ownerId = organization?.ownerId;
	const ownerIsPro = organization?.ownerIsPro ?? false;
	const proSeatsUsed =
		organization?.members?.filter(
			(m) => m.hasProSeat || (ownerIsPro && !!ownerId && m.userId === ownerId),
		).length ?? 0;
	const proSeatsRemaining = buildEnv.NEXT_PUBLIC_IS_CAP
		? Math.max(0, proSeatsTotal - proSeatsUsed)
		: Number.MAX_SAFE_INTEGER;

	return {
		proSeatsTotal,
		proSeatsUsed,
		proSeatsRemaining,
	};
}

export function calculateSeats(organization: {
	inviteQuota?: number;
	ownerId?: string | null;
	ownerIsPro?: boolean;
	members?: { id: string; userId?: string | null; hasProSeat?: boolean }[];
	invites?: { id: string }[];
}) {
	const { proSeatsTotal, proSeatsUsed, proSeatsRemaining } =
		calculateProSeats(organization);

	const memberCount = organization?.members?.length ?? 0;
	const pendingInvitesCount = organization?.invites?.length ?? 0;

	return {
		memberCount,
		pendingInvitesCount,
		proSeatsTotal,
		proSeatsUsed,
		proSeatsRemaining,
	};
}
