import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { useState } from "react";
import { useDashboardContext } from "../../../Contexts";
import DeleteOrgDialog from "./DeleteOrgDialog";

const DeleteOrg = () => {
	const [toggleDeleteDialog, setToggleDeleteDialog] = useState(false);
	const { organizationData, user } = useDashboardContext();

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
					disabled={organizationData?.length === 1}
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
