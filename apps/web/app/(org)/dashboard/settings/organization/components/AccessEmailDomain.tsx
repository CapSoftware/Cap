import { Button } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
import { useDashboardContext } from "../../../Contexts";
import { SettingRow } from "./SettingsRows";

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
				organizationId: activeOrganization?.organization
					.id as Organisation.OrganisationId,
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
		<div>
			<SettingRow
				label="Access email domain"
				description={
					'Restrict who can access public "anyone with the link" videos. Leave blank to allow anyone with the link.'
				}
				control={
					<Button
						className="min-w-fit"
						type="submit"
						spinner={saveLoading}
						size="xs"
						variant="dark"
						disabled={
							saveLoading ||
							emailDomain ===
								activeOrganization?.organization.allowedEmailDomain
						}
						onClick={handleEmailDomainSave}
					>
						{saveLoading ? null : "Save"}
					</Button>
				}
			/>
			<div className="flex flex-col gap-2 px-4 pb-4">
				<textarea
					aria-label="Access email domain"
					className="flex px-3 py-2 w-full font-thin transition-all duration-200 text-[16px] md:text-[13px] text-gray-12 bg-gray-1 border-gray-4 outline-0 focus:bg-gray-2 rounded-lg hover:bg-gray-2 border-[1px] focus:border-gray-5 placeholder:text-gray-8 ring-0 ring-gray-2 focus:ring-1 focus:ring-gray-12 focus:ring-offset-2 ring-offset-gray-3 hover:placeholder:text-gray-12 placeholder:duration-200 min-h-[64px] resize-y shadow-xs"
					placeholder="e.g. company.com, partner.org, larry@google.com"
					value={emailDomain || ""}
					id="allowedEmailDomain"
					name="allowedEmailDomain"
					onChange={(e) => {
						setEmailDomain(e.target.value);
					}}
				/>
				<p className="text-[13px] text-gray-10">
					Add email domains (e.g.{" "}
					<code className="text-xs bg-gray-3 px-1 py-0.5 rounded">
						company.com
					</code>
					) or specific email addresses (e.g.{" "}
					<code className="text-xs bg-gray-3 px-1 py-0.5 rounded">
						larry@google.com
					</code>
					), separated by commas. Members of your organization and spaces can
					always access videos shared with them, regardless of this setting.
				</p>
			</div>
		</div>
	);
};

export default AccessEmailDomain;
