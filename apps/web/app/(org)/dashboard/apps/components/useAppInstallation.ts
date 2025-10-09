"use client";

import {
	type AppDefinitionType,
	type AppInstallationViewType,
	type AppSelection,
	type AppStatusKey,
	useAppsUi,
} from "@cap/apps/ui";
import { Effect, Option } from "effect";
import { useCallback, useMemo, useState } from "react";

import { useEffectQuery } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";

type UseAppInstallationArgs = {
	definition: AppDefinitionType;
	onOpenManage?: (selection: AppSelection) => void;
};

type UseAppInstallationResult = {
	installation: AppInstallationViewType | null;
	status: AppStatusKey;
	providerDisplayName: string | null;
	hasInstallationError: boolean;
	buttonLabel: string;
	buttonDisabled: boolean;
	buttonSpinner: boolean;
	handleAction: () => Promise<void>;
	installationQuery: ReturnType<
		typeof useEffectQuery<AppInstallationViewType | null, unknown, true>
	>;
};

export const useAppInstallation = ({
	definition,
	onOpenManage,
}: UseAppInstallationArgs): UseAppInstallationResult => {
	const { toast } = useAppsUi();
	const [isAuthorizing, setIsAuthorizing] = useState(false);

	const installationQuery = useEffectQuery<
		AppInstallationViewType | null,
		unknown,
		true
	>({
		throwOnDefect: true,
		queryKey: ["apps", "installation", definition.slug],
		queryFn: () =>
			withRpc((rpc) =>
				rpc
					.AppsGetInstallation({ slug: definition.slug })
					.pipe(Effect.map((installation) => Option.getOrNull(installation))),
			),
		staleTime: 30_000,
	});

	const installation = installationQuery.data ?? null;

	const status: AppStatusKey = useMemo(() => {
		if (!installation) return "not_installed";
		return installation.status;
	}, [installation]);

	const providerDisplayName = installation
		? Option.getOrNull(installation.providerDisplayName)
		: null;
	const hasInstallationError = Boolean(installationQuery.error);
	const buttonLabel = installation ? "Manage" : "Install";

	const startInstallFlow = useCallback(async () => {
		try {
			setIsAuthorizing(true);
			const response = await fetch("/api/apps/connect/authorize", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ app: definition.slug }),
			});

			if (!response.ok) {
				toast.error("Unable to start the connection flow.");
				return;
			}

			const payload = (await response.json()) as { authorizationUrl?: string };

			if (payload.authorizationUrl) {
				window.location.href = payload.authorizationUrl;
			} else {
				toast.error("Authorization URL missing from response.");
			}
		} catch (error) {
			console.error(error);
			toast.error("Unable to start the connection flow.");
		} finally {
			setIsAuthorizing(false);
		}
	}, [definition.slug, toast]);

	const handleAction = useCallback(async () => {
		if (!installation) {
			await startInstallFlow();
			return;
		}

		if (!onOpenManage) return;
		onOpenManage({ definition, installation });
	}, [definition, installation, onOpenManage, startInstallFlow]);

	const buttonSpinner = installationQuery.isFetching || isAuthorizing;
	const buttonDisabled =
		installationQuery.isLoading ||
		(installation ? !onOpenManage : isAuthorizing);

	return {
		installation,
		status,
		providerDisplayName,
		hasInstallationError,
		buttonLabel,
		buttonDisabled,
		buttonSpinner,
		handleAction,
		installationQuery,
	};
};
