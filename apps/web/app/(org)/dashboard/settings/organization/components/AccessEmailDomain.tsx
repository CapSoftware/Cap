import { Button, Switch } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
import { useDashboardContext } from "../../../Contexts";
import { SettingsRow } from "../_components/settings-ui";

export const AccessEmailDomain = () => {
	const { activeOrganization, organizationSettings } = useDashboardContext();
	const savedLinkOverride =
		organizationSettings?.allowPublicLinkOverride === true;
	const [linkOverride, setLinkOverride] = useState(savedLinkOverride);
	const [linkOverrideLoading, setLinkOverrideLoading] = useState(false);
	const linkOverrideId = useId();
	const emailDomainInputId = useId();
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

	const handleLinkOverrideChange = async (checked: boolean) => {
		setLinkOverride(checked);
		setLinkOverrideLoading(true);
		try {
			await updateOrganizationDetails({
				allowPublicLinkOverride: checked,
				organizationId: activeOrganization?.organization
					.id as Organisation.OrganisationId,
			});
			toast.success("Settings updated successfully");
			router.refresh();
		} catch (error) {
			console.error("Error updating settings:", error);
			setLinkOverride(!checked);
			toast.error("An error occurred while updating settings");
		} finally {
			setLinkOverrideLoading(false);
		}
	};

	return (
		<>
			<SettingsRow
				title={
					<label htmlFor={emailDomainInputId}>Email access restriction</label>
				}
				description={
					<>
						Restrict who can access public &quot;anyone with the link&quot;
						videos. Add email domains (e.g.{" "}
						<code className="px-1 py-0.5 text-xs rounded bg-gray-3">
							company.com
						</code>
						) or specific email addresses (e.g.{" "}
						<code className="px-1 py-0.5 text-xs rounded bg-gray-3">
							larry@google.com
						</code>
						), separated by commas. Members of your organization and spaces can
						always access videos shared with them.{" "}
						<span className="font-medium text-gray-11">
							Leave blank to allow anyone with the link.
						</span>
					</>
				}
			>
				<div className="flex flex-col gap-3 mt-4">
					<textarea
						className="flex px-3 py-2.5 w-full text-[16px] md:text-[13px] text-gray-12 bg-gray-1 rounded-lg border border-gray-4 transition-colors duration-200 outline-none resize-y min-h-[76px] placeholder:text-gray-9 hover:border-gray-5 focus:border-gray-7 focus:ring-2 focus:ring-gray-4"
						placeholder="e.g. company.com, partner.org, larry@google.com"
						value={emailDomain || ""}
						id={emailDomainInputId}
						name="allowedEmailDomain"
						onChange={(e) => {
							setEmailDomain(e.target.value);
						}}
					/>
					<div className="flex justify-end">
						<Button
							className="px-4 h-9 min-w-fit"
							type="submit"
							spinner={saveLoading}
							size="sm"
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
					</div>
				</div>
			</SettingsRow>
			{activeOrganization?.organization.allowedEmailDomain?.trim() && (
				<SettingsRow
					title={
						<label htmlFor={linkOverrideId}>
							Let members open individual videos
						</label>
					}
					description="A video's owner can switch its link to anyone with the link. Every other video stays restricted."
					control={
						<Switch
							id={linkOverrideId}
							checked={linkOverride}
							disabled={linkOverrideLoading}
							onCheckedChange={handleLinkOverrideChange}
						/>
					}
				/>
			)}
		</>
	);
};

export default AccessEmailDomain;
