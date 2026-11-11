import type { Metadata } from "next";
import { requireInfraApp } from "../../infra-data";
import { AppSettingsClient } from "./app-settings-client";
import { DomainsSection } from "./domains-section";

export const metadata: Metadata = {
	title: "Settings | Cap Infra",
};

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
			domains={
				<DomainsSection
					appId={app.id}
					environment={app.environment}
					domains={app.domains.map((d) => ({ id: d.id, domain: d.domain }))}
				/>
			}
		/>
	);
}
