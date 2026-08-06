import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { useState } from "react";
import { getEffectiveOrganizationRole } from "@/lib/permissions/roles";
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
	const canDeleteOrganization = currentRole === "owner";

	return (
		<>
			{canDeleteOrganization && (
				<DeleteOrgDialog
					open={toggleDeleteDialog}
					onOpenChange={setToggleDeleteDialog}
				/>
			)}
			<Card className="flex flex-wrap gap-6 justify-between items-center w-full">
				<CardHeader>
					<CardTitle>Delete Organization</CardTitle>
					<CardDescription>
						{canDeleteOrganization
							? "Delete your organization and all associated data."
							: "Deleting this organization requires the owner's permission."}
					</CardDescription>
				</CardHeader>
				{canDeleteOrganization && (
					<Button
						variant="destructive"
						disabled={!activeOrganization || !organizationData}
						size="sm"
						onClick={(e) => {
							e.stopPropagation();
							e.preventDefault();
							setToggleDeleteDialog(true);
						}}
					>
						Delete Organization
					</Button>
				)}
			</Card>
		</>
	);
};

export default DeleteOrg;
