"use client";

import AccessEmailDomain from "./components/AccessEmailDomain";
import { CustomDomain } from "./components/CustomDomain";
import DeleteOrg from "./components/DeleteOrg";
import { OrganizationIcon } from "./components/OrganizationIcon";
import OrgName from "./components/OrgName";
import { ShareableLinkIcon } from "./components/ShareableLinkIcon";

export function GeneralPage() {
	return (
		<div className="flex flex-col w-full max-w-2xl">
			<section>
				<h2 className="text-sm font-medium text-gray-12">Organization</h2>
				<div className="mt-3 rounded-xl border divide-y shadow-xs border-gray-3 divide-gray-3 bg-gray-1">
					<OrgName />
					<OrganizationIcon />
					<ShareableLinkIcon />
				</div>
			</section>

			<section className="mt-10">
				<h2 className="text-sm font-medium text-gray-12">Access</h2>
				<div className="mt-3 rounded-xl border divide-y shadow-xs border-gray-3 divide-gray-3 bg-gray-1">
					<CustomDomain />
					<AccessEmailDomain />
				</div>
			</section>

			<section className="mt-10">
				<h2 className="text-sm font-medium text-gray-12">Danger zone</h2>
				<div className="mt-3 rounded-xl border divide-y shadow-xs border-gray-3 divide-gray-3 bg-gray-1">
					<DeleteOrg />
				</div>
			</section>
		</div>
	);
}
