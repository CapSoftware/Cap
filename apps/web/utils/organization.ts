import { buildEnv } from "@cap/env";

export function calculateProSeats(organization: {
	inviteQuota?: number;
	members?: { id: string; hasProSeat?: boolean }[];
}) {
	const proSeatsTotal = organization?.inviteQuota ?? 1;
	const proSeatsUsed =
		organization?.members?.filter((m) => m.hasProSeat).length ?? 0;
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
	members?: { id: string; hasProSeat?: boolean }[];
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
