"use client";

import { Plus } from "lucide-react";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { Tooltip } from "@/components/Tooltip";
import { useDashboardContext } from "../../Contexts";

const MAX_VISIBLE = 4;

export function MemberAvatars() {
	const { activeOrganization, sidebarCollapsed, setInviteDialogOpen, user } =
		useDashboardContext();

	const isOwner = user?.id === activeOrganization?.organization.ownerId;

	if (sidebarCollapsed) return null;

	const members = activeOrganization?.members ?? [];
	const visibleMembers = members.slice(0, MAX_VISIBLE);
	const extraCount = members.length - MAX_VISIBLE;
	const emptySlots = Math.max(0, MAX_VISIBLE - members.length);

	return (
		<div className="flex items-center mt-2.5 px-2.5">
			{visibleMembers.map((member, i) => (
				<Tooltip
					key={member.id}
					content={member.user.name ?? member.user.email}
					position="bottom"
					delayDuration={0}
				>
					<div className={i > 0 ? "-ml-1.5" : ""}>
						<SignedImageUrl
							image={member.user.image}
							name={member.user.name ?? member.user.email}
							className="size-6 ring-2 ring-gray-3 rounded-full"
							letterClass="text-[10px]"
						/>
					</div>
				</Tooltip>
			))}

			{extraCount > 0 && (
				<div className="-ml-1.5 flex items-center justify-center size-6 rounded-full bg-gray-4 ring-2 ring-gray-3">
					<span className="text-[9px] font-medium text-gray-11">
						+{extraCount}
					</span>
				</div>
			)}

			{isOwner &&
				Array.from({ length: emptySlots }).map((_, i) => (
					<Tooltip
						key={`empty-${i}`}
						content="Invite to your organization"
						position="bottom"
						delayDuration={0}
					>
						<button
							type="button"
							onClick={() => setInviteDialogOpen(true)}
							className="-ml-1.5 flex items-center justify-center size-6 rounded-full border border-dashed border-gray-8 bg-gray-3 hover:bg-gray-4 hover:border-gray-9 transition-colors"
						>
							<Plus className="size-3 text-gray-10" />
						</button>
					</Tooltip>
				))}
		</div>
	);
}
