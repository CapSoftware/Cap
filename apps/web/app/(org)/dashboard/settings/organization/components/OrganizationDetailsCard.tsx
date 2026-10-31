"use client";

import { Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { useDashboardContext } from "../../../Contexts";
import AccessEmailDomain from "./AccessEmailDomain";
import { CustomDomain } from "./CustomDomain";
import { OrganizationIcon } from "./OrganizationIcon";
import OrgName from "./OrgName";
import { ShareableLinkIcon } from "./ShareableLinkIcon";

export const OrganizationDetailsCard = () => {
	const { activeOrganization } = useDashboardContext();
	return (
		<Card
			key={activeOrganization?.organization.id}
			className="flex flex-col flex-1 gap-6 w-full min-h-fit"
		>
			<CardHeader>
				<CardTitle>Settings</CardTitle>
				<CardDescription>
					Set the organization name, access email domain, custom domain, and
					organization icons.
				</CardDescription>
			</CardHeader>
			<div className="grid grid-cols-1 gap-8 md:grid-cols-2">
				<OrgName />
				<CustomDomain />
				<OrganizationIcon />
				<ShareableLinkIcon />
				<AccessEmailDomain />
			</div>
		</Card>
	);
};
