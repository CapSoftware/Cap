"use client";

import { useDashboardContext } from "../../../Contexts";
import { SettingsCard, SettingsSection } from "../_components/settings-ui";
import AccessEmailDomain from "./AccessEmailDomain";
import { CustomDomain } from "./CustomDomain";
import { OrganizationIcon } from "./OrganizationIcon";
import OrgName from "./OrgName";
import { ShareableLinkIcon } from "./ShareableLinkIcon";

export const OrganizationDetailsCard = () => {
	const { activeOrganization } = useDashboardContext();
	return (
		<div
			key={activeOrganization?.organization.id}
			className="flex flex-col gap-10"
		>
			<SettingsSection title="Organization">
				<SettingsCard>
					<OrgName />
					<OrganizationIcon />
				</SettingsCard>
			</SettingsSection>
			<SettingsSection title="Shareable links">
				<SettingsCard>
					<CustomDomain />
					<ShareableLinkIcon />
				</SettingsCard>
			</SettingsSection>
			<SettingsSection title="Access">
				<SettingsCard>
					<AccessEmailDomain />
				</SettingsCard>
			</SettingsSection>
		</div>
	);
};
