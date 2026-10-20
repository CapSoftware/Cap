import type { Metadata } from "next";
import { getContentManagementSetup } from "@/actions/organization/content-transfer";
import { ContentManagement } from "./ContentManagement";

export const metadata: Metadata = {
	title: "Content Management — Cap",
};

export default async function OrganizationContentPage() {
	const setup = await getContentManagementSetup();
	return <ContentManagement initialSetup={setup} />;
}
