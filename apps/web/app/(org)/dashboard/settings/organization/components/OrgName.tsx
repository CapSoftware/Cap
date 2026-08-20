"use client";

import { Button, Input } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
import { useDashboardContext } from "../../../Contexts";
import { SettingRow } from "./SettingsRows";

const OrgName = () => {
	const { activeOrganization } = useDashboardContext();
	const [orgName, setOrgName] = useState(activeOrganization?.organization.name);
	const [saveLoading, setSaveLoading] = useState(false);
	const router = useRouter();

	const handleOrgNameChange = async () => {
		try {
			if (!orgName || !activeOrganization?.organization.id) return;
			setSaveLoading(true);
			await updateOrganizationDetails({
				organizationName: orgName,
				organizationId: activeOrganization.organization.id,
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
		<SettingRow
			label="Organization name"
			description="Changing the name will update how your organization appears to other members."
			control={
				<div className="flex gap-2 items-center">
					<Input
						type="text"
						aria-label="Organization name"
						className="px-3 w-56 h-8 rounded-lg shadow-xs"
						value={orgName}
						id="organizationName"
						name="organizationName"
						onChange={(e) => {
							setOrgName(e.target.value);
						}}
					/>
					<Button
						type="submit"
						size="xs"
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
			}
		/>
	);
};

export default OrgName;
