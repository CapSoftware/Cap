"use client";

import { Button, Input } from "@cap/ui";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
import { useDashboardContext } from "../../../Contexts";
import { SettingsRow, settingsFieldClass } from "../_components/settings-ui";

const OrgName = () => {
	const { activeOrganization } = useDashboardContext();
	const [orgName, setOrgName] = useState(activeOrganization?.organization.name);
	const [saveLoading, setSaveLoading] = useState(false);
	const nameInputId = useId();
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
		<SettingsRow
			title={<label htmlFor={nameInputId}>Name</label>}
			description="Changing the name will update how your organization appears to other members."
			control={
				<div className="flex gap-2 items-center w-full sm:w-auto">
					<Input
						type="text"
						className={clsx(settingsFieldClass, "w-full sm:w-60")}
						value={orgName}
						id={nameInputId}
						name="organizationName"
						onChange={(e) => {
							setOrgName(e.target.value);
						}}
					/>
					<Button
						type="submit"
						size="sm"
						className="px-4 h-9 min-w-fit"
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
