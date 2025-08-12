/**
 * Calculate organization seats information
 */
export function calculateSeats(organization: {
	inviteQuota?: number;
	members?: { id: string }[];
	invites?: { id: string }[];
}) {
	const inviteQuota = organization?.inviteQuota ?? 1;
	const memberCount = organization?.members?.length ?? 0;
	const pendingInvitesCount = organization?.invites?.length ?? 0;
	const totalUsedSeats = memberCount + pendingInvitesCount;
	const remainingSeats =
		process.env.NODE_ENv === "development"
			? Number.MAX_SAFE_INTEGER
			: Math.max(0, inviteQuota - totalUsedSeats);

	return {
		inviteQuota,
		memberCount,
		pendingInvitesCount,
		totalUsedSeats,
		remainingSeats,
	};
}
