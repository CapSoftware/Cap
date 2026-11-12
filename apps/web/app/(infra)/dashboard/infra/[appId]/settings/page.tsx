import { infraPageMetadata, requireInfraApp } from "../../infra-data";
import { AppSettingsClient } from "./app-settings-client";

export const generateMetadata = infraPageMetadata("Settings");

export default async function InfraSettingsPage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app } = await requireInfraApp(appId);

	return (
		<AppSettingsClient
			key={`${app.id}:${app.name}:${app.environment}`}
			appId={app.id}
			name={app.name}
			environment={app.environment}
			balanceMicroCredits={app.creditAccount?.balanceMicroCredits ?? 0}
			videoCount={app.videoCount}
		/>
	);
}
