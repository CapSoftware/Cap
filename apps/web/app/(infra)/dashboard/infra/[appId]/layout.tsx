import { Shell } from "../_components/shell";
import { UploadsProvider } from "../_components/uploads";
import { requireInfraApp, toInfraAppSummary } from "../infra-data";

export default async function InfraAppLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app, apps } = await requireInfraApp(appId);

	return (
		<UploadsProvider
			key={app.id}
			appId={app.id}
			balanceMicroCredits={app.creditAccount?.balanceMicroCredits ?? 0}
		>
			<Shell apps={apps.map(toInfraAppSummary)} appId={app.id}>
				{children}
			</Shell>
		</UploadsProvider>
	);
}
