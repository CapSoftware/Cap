"use client";

import type { ReactNode } from "react";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import {
	canManageOrganizationBilling,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import {
	SettingsCard,
	SettingsRow,
	SettingsSection,
} from "../_components/settings-ui";
import { BillingSummaryCard } from "../components/BillingSummaryCard";
import { SeatManagementCard } from "../components/SeatManagementCard";

export function BillingContent({ addOns }: { addOns: ReactNode }) {
	const { activeOrganization, user } = useDashboardContext();
	const currentMember = activeOrganization?.members.find(
		(member) => member.userId === user.id,
	);
	const currentRole = getEffectiveOrganizationRole({
		userId: user.id,
		ownerId: activeOrganization?.organization.ownerId,
		memberRole: currentMember?.role,
	});

	if (!canManageOrganizationBilling(currentRole)) {
		return (
			<SettingsSection title="Plan">
				<SettingsCard>
					<SettingsRow
						title="Billing"
						description="Billing is managed by the organization owner."
					/>
				</SettingsCard>
			</SettingsSection>
		);
	}

	return (
		<div className="flex flex-col gap-10">
			<SettingsSection title="Plan">
				<SettingsCard>
					<BillingSummaryCard />
					{activeOrganization?.hasActiveProSeatProvider && (
						<SeatManagementCard />
					)}
				</SettingsCard>
			</SettingsSection>
			{addOns}
		</div>
	);
}
