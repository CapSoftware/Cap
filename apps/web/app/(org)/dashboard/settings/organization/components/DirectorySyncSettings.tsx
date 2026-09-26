import { Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { unstable_rethrow } from "next/navigation";
import { getDirectorySyncSettings } from "@/actions/organization/directory-sync";
import { DirectorySyncCard } from "./DirectorySyncCard";

export async function DirectorySyncSettings({
	organizationId,
}: {
	organizationId: Organisation.OrganisationId;
}) {
	try {
		const settings = await getDirectorySyncSettings(organizationId);
		return (
			<DirectorySyncCard key={organizationId} initialSettings={settings} />
		);
	} catch (error) {
		unstable_rethrow(error);
		return (
			<Card>
				<CardHeader>
					<CardTitle>User provisioning</CardTitle>
					<CardDescription>
						Unable to load provisioning settings. Reload this page or contact
						Cap for help.
					</CardDescription>
				</CardHeader>
			</Card>
		);
	}
}
