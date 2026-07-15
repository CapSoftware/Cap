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
				<CardTitle>设置</CardTitle>
				<CardDescription>
					设置组织名称、准入邮箱域名、自定义域名和组织图标。
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
