import {
	getInfraAppDomains,
	getInfraVideoCount,
	infraPageMetadata,
	requireInfraApp,
} from "../../infra-data";
import { AppSettingsClient } from "./app-settings-client";
import { DomainsSection } from "./domains-section";

export const generateMetadata = infraPageMetadata("Settings");

export default async function InfraSettingsPage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app } = await requireInfraApp(appId);
	const [videoCount, domains] = await Promise.all([
		getInfraVideoCount(app.id),
		getInfraAppDomains(app.id),
	]);

	return (
		<AppSettingsClient
			key={`${app.id}:${app.name}:${app.environment}`}
			appId={app.id}
			name={app.name}
			environment={app.environment}
			balanceMicroCredits={app.creditAccount?.balanceMicroCredits ?? 0}
			videoCount={videoCount}
			domains={<DomainsSection appId={app.id} domains={domains} />}
		/>
	);
}
