import { Button, Input, Label } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
import { useDashboardContext } from "../../../Contexts";

export const AccessEmailDomain = () => {
	const { activeOrganization } = useDashboardContext();
	const [emailDomain, setEmailDomain] = useState(
		activeOrganization?.organization.allowedEmailDomain || null,
	);
	const [saveLoading, setSaveLoading] = useState(false);
	const router = useRouter();

	const handleEmailDomainSave = async () => {
		try {
			setSaveLoading(true);
			await updateOrganizationDetails({
				allowedEmailDomain: emailDomain,
				organizationId: activeOrganization?.organization.id as string,
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
				<Label htmlFor="allowedEmailDomain">Access email domain</Label>
				<p className="text-sm text-gray-10">
					Only emails from this domain can access shared videos.{" "}
					<span className="font-medium text-sm text-gray-11 leading-[0px]">
						Leave blank to allow everyone.
					</span>
				</p>
			</div>
			<div className="flex flex-col gap-3 w-full md:items-center md:flex-row h-fit">
				<Input
					type="text"
					className="bg-gray-2"
					placeholder="e.g. company.com"
					value={emailDomain || ""}
					id="allowedEmailDomain"
					name="allowedEmailDomain"
					onChange={(e) => {
						setEmailDomain(e.target.value);
					}}
				/>
				<Button
					className="min-w-fit"
					type="submit"
					spinner={saveLoading}
					size="sm"
					variant="dark"
					disabled={
						saveLoading ||
						emailDomain === activeOrganization?.organization.allowedEmailDomain
					}
					onClick={handleEmailDomainSave}
				>
					{saveLoading ? null : "Save"}
				</Button>
			</div>
		</div>
	);
};

export default AccessEmailDomain;
