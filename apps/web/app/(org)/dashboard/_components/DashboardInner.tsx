"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { useDashboardContext } from "../Contexts";
import { MembersDialog } from "../spaces/[spaceId]/components/MembersDialog";
import Top from "./Navbar/Top";

export default function DashboardInner({
	children,
}: {
	children: React.ReactNode;
}) {
	const { activeOrganization } = useDashboardContext();
	const [membersDialogOpen, setMembersDialogOpen] = useState(false);
	const isSharedCapsPage = usePathname() === "/dashboard/shared-caps";

	return (
		<div className="flex overflow-hidden w-full flex-col flex-1 md:mt-0 mt-[126px]">
			<Top />
			<main
				className={
					"flex flex-1 h-full [grid-area:main] bg-gray-1"
				}
			>
				{/* Content Area - this div prevents flickering when the sidebar is toggled */}
				<div className="flex overflow-hidden overflow-y-auto overscroll-contain flex-col flex-1 p-5 h-full rounded-tl-xl border border-b-0 bg-gray-2 border-gray-3 lg:p-8">
					<div className="flex flex-col flex-1 gap-4 min-h-fit">{children}</div>
				</div>
			</main>
			{isSharedCapsPage && activeOrganization?.members && (
				<MembersDialog
					open={membersDialogOpen}
					onOpenChange={setMembersDialogOpen}
					members={activeOrganization.members}
					organizationName={activeOrganization.organization.name || ""}
				/>
			)}
		</div>
	);
}
