import type { Metadata } from "next";
import Link from "next/link";
import { getContentManagementSetup } from "@/actions/organization/content-transfer";
import { ContentManagement } from "./ContentManagement";

export const metadata: Metadata = {
	title: "Content Management — Cap",
};

export default async function OrganizationContentPage() {
	const setup = await getContentManagementSetup();
	return (
		<>
			<Link
				href="/dashboard/settings/organization/content/recording-ownership"
				className="text-sm underline"
			>
				Transfer one recording while preserving sharing
			</Link>
			<ContentManagement initialSetup={setup} />
		</>
	);
}
