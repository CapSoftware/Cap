"use client";

import { Button, Input, Label } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
import { useDashboardContext } from "../../../Contexts";

const OrgName = () => {
	const { activeOrganization } = useDashboardContext();
	const [orgName, setOrgName] = useState(activeOrganization?.organization.name);
	const [saveLoading, setSaveLoading] = useState(false);
	const router = useRouter();

	const handleOrgNameChange = async () => {
		try {
			if (!orgName) return;
			setSaveLoading(true);
			await updateOrganizationDetails({
				organizationName: orgName,
				organizationId: activeOrganization?.organization.id,
			});
			toast.success("Settings updated successfully");
			router.refresh();
		} catch (error) {
			console.error("Error updating settings:", error);
			toast.error("An error occurred while updating settings");
		} finally {
			setSaveLoading(false);
		}
	};

	return (
		<div className="flex-1 space-y-4">
			<div className="space-y-1">
				<Label htmlFor="organizationName">Name</Label>
				<p className="text-sm text-gray-10">
					Changing the name will update how your organization appears to others
					members.
				</p>
			</div>
			<div className="flex flex-col gap-3 w-full md:items-center md:flex-row">
				<Input
					type="text"
					className="bg-gray-2"
					value={orgName}
					id="organizationName"
					name="organizationName"
					onChange={(e) => {
						setOrgName(e.target.value);
					}}
				/>
				<Button
					type="submit"
					size="sm"
					className="min-w-fit"
					variant="dark"
					spinner={saveLoading}
					onClick={handleOrgNameChange}
					disabled={
						saveLoading ||
						orgName === activeOrganization?.organization.name ||
						!orgName
					}
				>
					{saveLoading ? null : "Save"}
				</Button>
			</div>
		</div>
	);
};

export default OrgName;
