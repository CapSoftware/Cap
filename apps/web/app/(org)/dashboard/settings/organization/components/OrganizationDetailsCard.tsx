"use client";

import { Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import AccessEmailDomain from "./AccessEmailDomain";
import { CustomDomain } from "./CustomDomain";
import { OrganizationIcon } from "./OrganizationIcon";
import OrgName from "./OrgName";
import { ShareableLinkIcon } from "./ShareableLinkIcon";

export const OrganizationDetailsCard = () => {
	return (
		<Card className="flex flex-col flex-1 gap-6 w-full min-h-fit">
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
