"use client";

import { useParams } from "next/navigation";
import { EnvironmentBadge } from "../../_components/EnvironmentBadge";
import { useDevelopersContext } from "../../DevelopersContext";

export default function AppDetailLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const { appId } = useParams<{ appId: string }>();
	const { apps } = useDevelopersContext();
	const app = apps.find((a) => a.id === appId);

	return (
		<div className="flex flex-col gap-5">
			<div className="flex items-center gap-2">
				<h2 className="text-base font-medium text-gray-12">
					{app?.name ?? "App"}
				</h2>
				{app && <EnvironmentBadge environment={app.environment} />}
			</div>
			{children}
		</div>
	);
}
