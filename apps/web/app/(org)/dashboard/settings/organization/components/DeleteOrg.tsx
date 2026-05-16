import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { useState } from "react";
import {
	canManageOrganizationBilling,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { useDashboardContext } from "../../../Contexts";
import DeleteOrgDialog from "./DeleteOrgDialog";

const DeleteOrg = () => {
	const [toggleDeleteDialog, setToggleDeleteDialog] = useState(false);
	const { activeOrganization, organizationData, user } = useDashboardContext();
	const currentMember = activeOrganization?.members.find(
		(member) => member.userId === user.id,
	);
	const currentRole = getEffectiveOrganizationRole({
		userId: user.id,
		ownerId: activeOrganization?.organization.ownerId,
		memberRole: currentMember?.role,
	});
	const canDeleteOrganization = canManageOrganizationBilling(currentRole);

	return (
		<>
			<DeleteOrgDialog
				open={toggleDeleteDialog}
				onOpenChange={setToggleDeleteDialog}
			/>
			<Card className="flex flex-wrap gap-6 justify-between items-center w-full">
				<CardHeader>
					<CardTitle>Delete Organization</CardTitle>
					<CardDescription>
						Delete your organization and all associated data.{" "}
					</CardDescription>
				</CardHeader>
				<Button
					variant="destructive"
					disabled={organizationData?.length === 1 || !canDeleteOrganization}
					size="sm"
					onClick={(e) => {
						e.stopPropagation();
						e.preventDefault();
						setToggleDeleteDialog(true);
					}}
				>
					Delete Organization
				</Button>
			</Card>
		</>
	);
};

export default DeleteOrg;
