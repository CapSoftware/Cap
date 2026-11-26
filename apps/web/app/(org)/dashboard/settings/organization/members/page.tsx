"use client";

import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { MembersCard } from "../components/MembersCard";

export default function MembersPage() {
	const { setInviteDialogOpen } = useDashboardContext();
	return <MembersCard setIsInviteDialogOpen={setInviteDialogOpen} />;
}
