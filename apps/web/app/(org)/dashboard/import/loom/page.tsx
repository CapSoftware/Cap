import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { listLoomImportJobs } from "@/lib/loom-import/jobs";
import {
	loomImportDestinationFromSearchParams,
	loomImportPageHref,
} from "@/lib/loom-import-destination";
import { ImportLoomPage } from "./ImportLoomPage";

export const metadata: Metadata = {
	title: "Import from Loom — Cap",
};

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const [params, user] = await Promise.all([searchParams, getCurrentUser()]);
	const destination = loomImportDestinationFromSearchParams(params);
	const recentJobs = user?.activeOrganizationId
		? await listLoomImportJobs({
				userId: user.id,
				orgId: user.activeOrganizationId,
			})
		: [];
	return (
		<ImportLoomPage
			key={loomImportPageHref(destination)}
			initialDestination={destination}
			recentJobs={recentJobs}
		/>
	);
}
