import { InfraMobileNav } from "../_components/infra-mobile-nav";
import { InfraSidebarRegistrar } from "../_components/infra-sidebar-registrar";
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
		<>
			<InfraSidebarRegistrar
				apps={apps.map(toInfraAppSummary)}
				appId={app.id}
			/>
			<div className="flex flex-col gap-6 mx-auto w-full max-w-5xl">
				<InfraMobileNav appId={app.id} />
				{children}
			</div>
		</>
	);
}
