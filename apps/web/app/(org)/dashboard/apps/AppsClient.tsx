"use client";

import {
	type AppDefinitionType,
	type AppSelection,
	type AppSpace,
	AppsUiProvider,
	getAppManagementComponent,
} from "@cap/apps/ui";
import { Apps } from "@cap/web-domain";
import { useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { useEffectMutation, useEffectQuery } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";

import { AppCard } from "./components/AppCard";

const toastApi = {
	success: toast.success,
	error: toast.error,
};

const AppsClient = () => {
	const [selectedApp, setSelectedApp] = useState<AppSelection | null>(null);
	const { spacesData } = useDashboardContext();
	const spaces = spacesData ?? [];
	const appSpaces: AppSpace[] = useMemo(
		() =>
			spaces.map((space) => ({
				id: space.id,
				name: space.name,
			})),
		[spaces],
	);

	const uiDependencies = useMemo(
		() => ({
			useEffectQuery,
			useEffectMutation,
			withRpc,
			useQueryClient,
			toast: toastApi,
		}),
		[],
	);

	const definitionsQuery = useEffectQuery<AppDefinitionType[], unknown, true>({
		throwOnDefect: true,
		queryKey: ["apps", "definitions"],
		queryFn: () =>
			withRpc((rpc) =>
				rpc
					.AppsListDefinitions({})
					.pipe(
						Effect.map((definitions) =>
							[...definitions].sort((a, b) =>
								a.displayName.localeCompare(b.displayName),
							),
						),
					),
			),
		staleTime: 60_000,
	});

	const definitions = definitionsQuery.data ?? [];
	const hasDefinitionsError = Boolean(definitionsQuery.error);

	const skeletonItems = useMemo(
		() => Array.from({ length: 3 }, (_, index) => index),
		[],
	);

	const ManagementComponent = selectedApp
		? getAppManagementComponent(selectedApp.definition.slug)
		: null;

	return (
		<AppsUiProvider value={uiDependencies}>
			<div className="flex flex-col gap-6">
				<header className="flex flex-col gap-1">
					<h1 className="text-2xl font-semibold text-gray-12">Apps</h1>
					<p className="text-sm text-gray-11">
						Manage organization integrations and automations from one place.
					</p>
				</header>

				{definitionsQuery.isLoading ? (
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
						{skeletonItems.map((item) => (
							<div
								key={`apps-skeleton-${item}`}
								className="h-48 animate-pulse rounded-2xl border border-gray-4 bg-gray-3"
							/>
						))}
					</div>
				) : hasDefinitionsError ? (
					<div className="rounded-xl border border-red-6 bg-red-3 p-4 text-sm text-red-11">
						We couldn&apos;t load the Apps catalog. Refresh the page to try
						again.
					</div>
				) : definitions.length === 0 ? (
					<div className="rounded-xl border border-gray-4 bg-gray-2 p-6 text-sm text-gray-10">
						No apps are available yet. Check back soon as we expand the catalog.
					</div>
				) : (
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
						{definitions.map((definition) => (
							<AppCard
								key={definition.slug}
								definition={definition}
								isActive={selectedApp?.definition.slug === definition.slug}
								onOpenManage={(selection) => setSelectedApp(selection)}
							/>
						))}
					</div>
				)}

				{selectedApp &&
					(ManagementComponent ? (
						<ManagementComponent
							selection={selectedApp}
							spaces={appSpaces}
							onClose={() => setSelectedApp(null)}
							onSelectionChange={(next) => setSelectedApp(next)}
						/>
					) : (
						<div className="rounded-xl border border-gray-4 bg-gray-2 p-6 text-sm text-gray-10">
							Management for {selectedApp.definition.displayName} isn&apos;t
							available yet.
						</div>
					))}
			</div>
		</AppsUiProvider>
	);
};

export default AppsClient;
