"use client";

import { buildEnv } from "@cap/env";
import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { BillingSummaryCard } from "../components/BillingSummaryCard";
import { MembersCard } from "../components/MembersCard";
import { SeatManagementCard } from "../components/SeatManagementCard";

export default function BillingAndMembersPage() {
	const { activeOrganization, user, setInviteDialogOpen } =
		useDashboardContext();
	const isOwner =
		activeOrganization?.members?.some(
			(member) => member.userId === user?.id && member.role === "owner",
		) ?? false;
	const ownerToastShown = useRef(false);

	const showOwnerToast = useCallback(() => {
		if (!ownerToastShown.current) {
			toast.error("Only the owner can make changes");
			ownerToastShown.current = true;
			setTimeout(() => {
				ownerToastShown.current = false;
			}, 3000);
		}
	}, []);

	return (
		<div className="flex flex-col gap-6">
			{buildEnv.NEXT_PUBLIC_IS_CAP && <BillingSummaryCard />}
			{buildEnv.NEXT_PUBLIC_IS_CAP && <SeatManagementCard />}
			<MembersCard
				isOwner={isOwner}
				showOwnerToast={showOwnerToast}
				setIsInviteDialogOpen={setInviteDialogOpen}
			/>
		</div>
	);
}
