import type { OrganisationMemberSeatType } from "@cap/database/schema";
import { buildEnv } from "@cap/env";

export function calculateSeats(organization: {
	paidSeats?: number;
	members?: { id: string; seatType?: OrganisationMemberSeatType }[];
	invites?: { id: string }[];
}) {
	const paidSeats = organization?.paidSeats ?? 0;
	const memberCount = organization?.members?.length ?? 0;
	const pendingInvitesCount = organization?.invites?.length ?? 0;
	const paidMemberCount =
		organization?.members?.filter((m) => m.seatType === "paid").length ?? 0;
	const usedPaidSeats = paidMemberCount;
	const remainingPaidSeats = buildEnv.NEXT_PUBLIC_IS_CAP
		? Math.max(0, paidSeats - usedPaidSeats)
		: Number.MAX_SAFE_INTEGER;

	return {
		paidSeats,
		memberCount,
		pendingInvitesCount,
		paidMemberCount,
		usedPaidSeats,
		remainingPaidSeats,
		canInviteUnlimited: true,
	};
}
