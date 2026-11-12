import { Shell } from "../_components/shell";
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
		<Shell apps={apps.map(toInfraAppSummary)} appId={app.id}>
			{children}
		</Shell>
	);
}
