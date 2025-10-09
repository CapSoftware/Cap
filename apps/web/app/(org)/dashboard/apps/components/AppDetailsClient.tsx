"use client";

import {
	AppsUiProvider,
	AppStatusBadge,
	type AppDefinitionType,
	type AppSelection,
	getAppManagementComponent,
} from "@cap/apps/ui";
import { Button, Card } from "@cap/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Option } from "effect";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { useEffectMutation, useEffectQuery } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";

import { useAppInstallation } from "./useAppInstallation";
import type { SerializableAppDefinition } from "../types";

type AppDetailsClientProps = {
	definition: SerializableAppDefinition;
};

const toastApi = {
	success: toast.success,
	error: toast.error,
};

export const AppDetailsClient = ({ definition }: AppDetailsClientProps) => {
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

	return (
		<AppsUiProvider value={uiDependencies}>
			<AppDetailsContent definition={definition} />
		</AppsUiProvider>
	);
};

const AppDetailsContent = ({
	definition,
}: AppDetailsClientProps) => {
	const hydratedDefinition = useMemo<AppDefinitionType>(() => {
		const base = {
			...definition,
			requiredEnvVars: Object.freeze([...definition.requiredEnvVars]),
			contentPath: Option.fromNullable(definition.contentPath),
			publisher: Object.freeze({ ...definition.publisher }),
		};

		return base as unknown as AppDefinitionType;
	}, [definition]);

	const [selectedApp, setSelectedApp] = useState<AppSelection | null>(null);
	const { spacesData } = useDashboardContext();
	const spaces = spacesData ?? [];
	const appSpaces = useMemo(
		() =>
			spaces.map((space) => ({
				id: space.id,
				name: space.name,
			})),
		[spaces],
	);

	const installationState = useAppInstallation({
		definition: hydratedDefinition,
		onOpenManage: setSelectedApp,
	});

	const {
		providerDisplayName,
		hasInstallationError,
		buttonLabel,
		buttonDisabled,
		buttonSpinner,
		handleAction,
		installationQuery,
		status,
	} = installationState;

	const ManagementComponent = selectedApp
		? getAppManagementComponent(selectedApp.definition.slug)
		: null;

	const appInitial = definition.displayName?.[0]?.toUpperCase() ?? "A";

	return (
		<div className="flex flex-col gap-6">
			<Card className="flex flex-col gap-6 border-gray-3 bg-gray-1 p-6">
				<div className="flex flex-wrap items-start gap-4">
					<div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl border border-gray-4 bg-white">
						{definition.image ? (
							<img
								src={definition.image}
								alt={`${definition.displayName} logo`}
								className="h-full w-full object-contain p-2"
								loading="lazy"
							/>
						) : (
							<span className="text-xl font-semibold text-gray-12">
								{appInitial}
							</span>
						)}
					</div>
					<div className="flex min-w-0 flex-1 flex-col gap-3">
						<div className="flex flex-wrap items-center gap-3">
							<h1 className="text-2xl font-semibold leading-tight text-gray-12">
								{definition.displayName}
							</h1>
							<AppStatusBadge status={status} />
						</div>
						<p className="text-base leading-relaxed text-gray-11">
							{definition.description}
						</p>
						<div className="flex flex-wrap items-center gap-2 text-sm text-gray-10">
							<span className="font-medium text-gray-12">Publisher:</span>
							<span>{definition.publisher.name}</span>
							<span className="text-gray-9">•</span>
							<a
								className="text-blue-11 underline-offset-2 hover:underline"
								href={`mailto:${definition.publisher.email}`}
							>
								{definition.publisher.email}
							</a>
						</div>
					</div>
				</div>

				<div className="flex flex-col gap-2 text-sm text-gray-10">
					{installationQuery.isLoading ? (
						<div className="h-4 w-40 animate-pulse rounded bg-gray-5" />
					) : providerDisplayName ? (
						<p>
							Connected as
							<span className="ml-1 font-medium text-gray-12">
								{providerDisplayName}
							</span>
						</p>
					) : (
						<p>Complete setup to start sharing automatically.</p>
					)}
					{hasInstallationError && (
						<p className="text-sm text-red-11">
							We couldn&apos;t load the latest status.
						</p>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-3">
					<Button
						variant="dark"
						size="md"
						disabled={buttonDisabled}
						spinner={buttonSpinner}
						onClick={handleAction}
					>
						{buttonLabel}
					</Button>
					<span className="text-xs font-medium uppercase tracking-wide text-gray-9">
						{definition.category.replace(/_/g, " ")}
					</span>
				</div>
			</Card>

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
	);
};
