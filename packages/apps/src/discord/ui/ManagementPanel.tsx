"use client";

import { Button, Select } from "@cap/ui";
import { formatDistanceToNow } from "date-fns";
import { Cause, Effect, Exit, Option } from "effect";
import { useEffect, useMemo, useState } from "react";

import {
	createManagementPanel,
	ManagementPanelSection,
} from "../../ui/management/ManagementPanelBuilder.tsx";
import type { AppStatusKey } from "../../ui/components/AppStatusBadge.tsx";
import type {
	AppDestinationType,
	AppInstallationViewType,
	AppManagementComponentProps,
} from "../../ui/types.ts";

const EMPTY_SELECTION = "";

const PERMISSION_LABELS: Record<string, string> = {
	VIEW_CHANNEL: "View Channel",
	SEND_MESSAGES: "Send Messages",
	EMBED_LINKS: "Embed Links",
};

type VerificationMetadata = {
	status: "verified" | "missing_permissions" | "unknown_destination";
	missingPermissions: string[];
	checkedAt: string | null;
	channelId: string | null;
	channelName: string | null;
} | null;

const parseVerificationMetadata = (input: unknown): VerificationMetadata => {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return null;
	}

	const record = input as Record<string, unknown>;
	const candidate = record.channelVerification;

	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
		return null;
	}

	const { status } = candidate as { status?: unknown };

	if (
		status !== "verified" &&
		status !== "missing_permissions" &&
		status !== "unknown_destination"
	) {
		return null;
	}

	const missingRaw =
		(candidate as { missingPermissions?: unknown }).missingPermissions ?? [];
	const missingPermissions = Array.isArray(missingRaw)
		? (missingRaw as unknown[]).filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	const checkedAtRaw = (candidate as { checkedAt?: unknown }).checkedAt;
	const channelIdRaw = (candidate as { channelId?: unknown }).channelId;
	const channelNameRaw = (candidate as { channelName?: unknown }).channelName;

	return {
		status,
		missingPermissions,
		checkedAt: typeof checkedAtRaw === "string" ? checkedAtRaw : null,
		channelId: typeof channelIdRaw === "string" ? channelIdRaw : null,
		channelName: typeof channelNameRaw === "string" ? channelNameRaw : null,
	};
};

const DiscordManagementPanel = createManagementPanel(
	({
		selection,
		spaces,
		onClose,
		onSelectionChange,
		ui: { useEffectQuery, useEffectMutation, useQueryClient, toast, withRpc },
	}) => {
		const queryClient = useQueryClient();
		const isInstalled = selection.installation !== null;
		const status: AppStatusKey = selection.installation
			? selection.installation.status
			: "not_installed";

		const destinationsQuery = useEffectQuery<
			AppDestinationType[],
			unknown,
			true
		>({
			throwOnDefect: true,
			enabled: isInstalled,
			queryKey: ["apps", "destinations", selection.definition.slug],
			queryFn: () =>
				withRpc((rpc) =>
					(rpc as any)
						.AppsListDestinations({ slug: selection.definition.slug })
						.pipe(
							Effect.map((list: Iterable<AppDestinationType>) =>
								Array.from(list),
							),
						),
				),
		});

		const destinations = destinationsQuery.data ?? [];
		const hasDestinationsError = Boolean(destinationsQuery.error);

		const currentSettings = useMemo(() => {
			if (!selection.installation) return null;
			const value = Option.getOrNull(selection.installation.settings);
			return value &&
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value)
				? (value as Record<string, unknown>)
				: null;
		}, [selection.installation]);

		const initialChannelId =
			(currentSettings?.channelId as string | undefined) ?? EMPTY_SELECTION;
		const initialChannelName =
			(currentSettings?.channelName as string | undefined) ?? "";
		const initialSpaceId =
			(currentSettings?.spaceId as string | undefined) ??
			(selection.installation
				? Option.getOrElse(selection.installation.spaceId, () => EMPTY_SELECTION)
				: EMPTY_SELECTION);

		const [channelId, setChannelId] = useState(initialChannelId);
		const [channelName, setChannelName] = useState(initialChannelName);
		const [spaceId, setSpaceId] = useState(initialSpaceId);
		const [isAuthorizing, setIsAuthorizing] = useState(false);

		useEffect(() => {
			setChannelId(initialChannelId);
			setChannelName(initialChannelName);
			setSpaceId(initialSpaceId);
		}, [initialChannelId, initialChannelName, initialSpaceId]);

		const channelOptions = useMemo(
			() =>
				destinations.map((destination) => ({
					value: destination.id,
					label: destination.name,
				})),
			[destinations],
		);

		useEffect(() => {
			if (channelId === EMPTY_SELECTION) return;
			const option = channelOptions.find(
				(candidate) => candidate.value === channelId,
			);
			if (option && option.label !== channelName) {
				setChannelName(option.label);
			}
		}, [channelId, channelOptions, channelName]);

		const spaceOptions = useMemo(
			() => spaces.map((space) => ({ value: space.id, label: space.name })),
			[spaces],
		);

		const selectedChannelLabel =
			channelOptions.find((option) => option.value === channelId)?.label ??
			channelName;
		const selectedSpaceLabel =
			spaceOptions.find((option) => option.value === spaceId)?.label ?? "";

		const hasChanges =
			isInstalled &&
			(channelId !== initialChannelId ||
				spaceId !== initialSpaceId ||
				selectedChannelLabel !== initialChannelName);

		const invalidateInstallation = () => {
			queryClient.invalidateQueries({
				queryKey: ["apps", "installation", selection.definition.slug],
			});
		};

		const updateSettingsMutation = useEffectMutation<
			AppInstallationViewType,
			unknown,
			true,
			AppInstallationViewType,
			{ spaceId: string; channelId: string; channelName: string }
		>({
			throwOnDefect: true,
			mutationFn: ({
				spaceId: nextSpaceId,
				channelId: nextChannelId,
				channelName: nextChannelName,
			}: {
				spaceId: string;
				channelId: string;
				channelName: string;
			}) =>
				withRpc((rpc) =>
					(rpc as any).AppsUpdateSettings({
						slug: selection.definition.slug,
						settings: {
							channelId: nextChannelId,
							channelName: nextChannelName,
							spaceId: nextSpaceId,
						},
					}),
				),
		});

		const pauseMutation = useEffectMutation<
			AppInstallationViewType,
			unknown,
			true
		>({
			throwOnDefect: true,
			mutationFn: () =>
				withRpc((rpc) =>
					(rpc as any).AppsPause({ slug: selection.definition.slug }),
				),
		});

		const resumeMutation = useEffectMutation<
			AppInstallationViewType,
			unknown,
			true
		>({
			throwOnDefect: true,
			mutationFn: () =>
				withRpc((rpc) =>
					(rpc as any).AppsResume({ slug: selection.definition.slug }),
				),
		});

		const uninstallMutation = useEffectMutation<
			{ uninstalled: boolean },
			unknown,
			true
		>({
			throwOnDefect: true,
			mutationFn: () =>
				withRpc((rpc) =>
					(rpc as any).AppsUninstall({ slug: selection.definition.slug }),
				),
		});

		const dispatchTestMutation = useEffectMutation<
			{ remoteId: string | null },
			unknown,
			true
		>({
			throwOnDefect: true,
			mutationFn: () =>
				withRpc((rpc) =>
					(rpc as any)
						.AppsDispatchTest({ slug: selection.definition.slug })
						.pipe(
							Effect.map((output: { remoteId: Option.Option<string> }) => ({
								remoteId: Option.getOrNull(output.remoteId),
							})),
						),
				),
		});

		const verifyDestinationMutation = useEffectMutation<
			AppInstallationViewType,
			unknown,
			true
		>({
			throwOnDefect: true,
			mutationFn: () =>
				withRpc((rpc) =>
					(rpc as any).AppsVerifyDestination({
						slug: selection.definition.slug,
					}),
				),
		});

		const handleSave = async () => {
			if (!isInstalled) return;
			if (!channelId || !spaceId) {
				toast.error("Select both a channel and a Cap space before saving.");
				return;
			}

			try {
				const updatedResult = await updateSettingsMutation.mutateAsync({
					channelId,
					channelName: selectedChannelLabel,
					spaceId,
				});

				if (Exit.isFailure(updatedResult)) {
					console.error(Cause.pretty(updatedResult.cause));
					toast.error("Unable to update settings. Please try again.");
					return;
				}

				const updated = updatedResult.value;
				toast.success("Automation settings updated.");
				onSelectionChange({
					definition: selection.definition,
					installation: updated,
				});
				invalidateInstallation();
			} catch (error) {
				console.error(error);
				toast.error("Unable to update settings. Please try again.");
			}
		};

		const handlePause = async () => {
			try {
				const updatedResult = await pauseMutation.mutateAsync();
				if (Exit.isFailure(updatedResult)) {
					console.error(Cause.pretty(updatedResult.cause));
					toast.error("Failed to pause automation.");
					return;
				}
				const updated = updatedResult.value;
				toast.success("Automation paused.");
				onSelectionChange({
					definition: selection.definition,
					installation: updated,
				});
				invalidateInstallation();
			} catch (error) {
				console.error(error);
				toast.error("Failed to pause automation.");
			}
		};

		const handleResume = async () => {
			try {
				const updatedResult = await resumeMutation.mutateAsync();
				if (Exit.isFailure(updatedResult)) {
					console.error(Cause.pretty(updatedResult.cause));
					toast.error("Failed to resume automation.");
					return;
				}
				const updated = updatedResult.value;
				toast.success("Automation resumed.");
				onSelectionChange({
					definition: selection.definition,
					installation: updated,
				});
				invalidateInstallation();
			} catch (error) {
				console.error(error);
				toast.error("Failed to resume automation.");
			}
		};

		const handleUninstall = async () => {
			const confirmation = window.confirm(
				`Uninstall ${selection.definition.displayName}? This will remove saved credentials and stop posting automatically.`,
			);

			if (!confirmation) return;

			try {
				const uninstallResult = await uninstallMutation.mutateAsync();
				if (Exit.isFailure(uninstallResult)) {
					console.error(Cause.pretty(uninstallResult.cause));
					toast.error("Failed to uninstall the app.");
					return;
				}
				toast.success(`${selection.definition.displayName} uninstalled.`);
				onSelectionChange(null);
				invalidateInstallation();
			} catch (error) {
				console.error(error);
				toast.error("Failed to uninstall the app.");
			}
		};

		const handleDispatchTest = async () => {
			try {
				const dispatchResult = await dispatchTestMutation.mutateAsync();
				if (Exit.isFailure(dispatchResult)) {
					console.error(Cause.pretty(dispatchResult.cause));
					toast.error("Unable to dispatch a test message.");
					return;
				}
				toast.success("Sent a test post to the connected channel.");
			} catch (error) {
				console.error(error);
				toast.error("Unable to dispatch a test message.");
			}
		};

		const handleAuthorize = async () => {
			try {
				setIsAuthorizing(true);
				const response = await fetch("/api/apps/connect/authorize", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ app: selection.definition.slug }),
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
		};

		const handleVerify = async () => {
			if (!isInstalled) return;
			try {
				const verifyResult = await verifyDestinationMutation.mutateAsync();
				if (Exit.isFailure(verifyResult)) {
					console.error(Cause.pretty(verifyResult.cause));
					toast.error("We couldn’t refresh permissions. Try again.");
					return;
				}

				const updated = verifyResult.value;
				if (updated.status === "connected") {
					toast.success("Cap can post in the selected channel.");
				} else {
					toast.error(
						"Cap still needs permission to post. Follow the steps and try again.",
					);
				}

				onSelectionChange({
					definition: selection.definition,
					installation: updated,
				});
				invalidateInstallation();
			} catch (error) {
				console.error(error);
				toast.error("We couldn’t refresh permissions. Try again.");
			}
		};

		const isConnected = status === "connected";
		const isPaused = status === "paused";
		const needsAttention = status === "needs_attention";

		const lastCheckedLabel = selection.installation
			? Option.match(selection.installation.lastCheckedAt, {
					onNone: () => null,
					onSome: (date) =>
						formatDistanceToNow(date, { addSuffix: true }),
				})
			: null;

		const verification = useMemo(
			() =>
				parseVerificationMetadata(
					selection.installation
						? Option.getOrNull(selection.installation.providerMetadata)
						: null,
				),
			[selection.installation],
		);

		const missingPermissionLabels = useMemo(
			() =>
				(verification?.missingPermissions ?? []).map(
					(permission) => PERMISSION_LABELS[permission] ?? permission.replace(/_/g, " "),
				),
			[verification],
		);

		const showPermissionHelp =
			needsAttention && verification?.status === "missing_permissions";
		const showUnknownChannelHelp =
			needsAttention && verification?.status === "unknown_destination";

		const summaryContent = (() => {
			if (!isInstalled) {
				return (
					<p>
						Connect {selection.definition.displayName} to choose a destination
						channel and start sharing recordings automatically.
					</p>
				);
			}

			if (!selectedSpaceLabel || !selectedChannelLabel) {
				return (
					<p>Select a space and channel to control where automations run.</p>
				);
			}

			if (needsAttention) {
				if (verification?.status === "missing_permissions") {
					return (
						<p>
							We need permission to post in
							<span className="font-medium text-gray-12">
								 {selectedChannelLabel}
							</span>
							. Follow the steps to grant access and run Check permissions.
						</p>
					);
				}

				if (verification?.status === "unknown_destination") {
					return (
						<p>
							We can’t find this channel anymore. Choose another channel or
							reconnect the Discord app.
						</p>
					);
				}

				return (
					<p>
						Reconnect the Discord app to refresh permissions for
						<span className="font-medium text-gray-12">
							 {selectedChannelLabel}
						</span>
						.
					</p>
				);
			}

			return (
				<p>
					New videos shared to
					<span className="font-medium text-gray-12">
						 {selectedSpaceLabel}
					</span>
					will post in
					<span className="font-medium text-gray-12">
						 {selectedChannelLabel}
					</span>
					.
				</p>
			);
		})();

		const sideContent = (() => {
			if (showPermissionHelp) {
				return (
					<div className="rounded-xl border border-amber-6 bg-amber-3 p-4 text-amber-12">
						<h3 className="text-sm font-semibold">Allow Cap to post</h3>
						{missingPermissionLabels.length > 0 && (
							<p className="mt-2 text-xs text-amber-11">
								Missing permissions: {missingPermissionLabels.join(", ")}
							</p>
						)}
						<ol className="mt-3 list-decimal space-y-2 pl-4 text-amber-11">
							<li>
								In Discord, open the channel settings and go to
								Permissions.
							</li>
							<li>
								Add <span className="font-medium text-amber-12">Cap</span> to the
								Roles / Members list.
							</li>
							<li>
								Grant the required permissions and save.
							</li>
							<li>
								Back in Cap, click
								<span className="font-medium text-amber-12">
									 Check permissions
								</span>
								to refresh the status.
							</li>
						</ol>
					</div>
				);
			}

			if (showUnknownChannelHelp) {
				return (
					<div className="rounded-xl border border-amber-6 bg-amber-3 p-4 text-amber-12">
						<h3 className="text-sm font-semibold">Choose an available channel</h3>
						<p className="mt-2 text-xs text-amber-11">
							Select another channel above or reconnect the Discord app, then
							check permissions again.
						</p>
						<ol className="mt-3 list-decimal space-y-2 pl-4 text-amber-11">
							<li>Pick a current channel from the list.</li>
							<li>Make sure Cap still has access to that channel.</li>
							<li>Click Check permissions to update the status.</li>
						</ol>
					</div>
				);
			}

			return undefined;
		})();

		return {
			title: `Manage ${selection.definition.displayName}`,
			description:
				"Configure destinations, toggle automation, and send test posts without leaving the dashboard.",
			status,
			lastCheckedLabel,
			onClose,
			sections: (
				<div className="grid gap-6 md:grid-cols-2">
					<ManagementPanelSection title="Destination channel">
						<Select
							placeholder={
								needsAttention
									? "Reconnect to load channels"
									: "Select a channel"
							}
							disabled={
								!isInstalled || destinationsQuery.isLoading
							}
							value={channelId}
							onValueChange={(value) => setChannelId(value)}
							options={channelOptions}
						/>
						{destinationsQuery.isLoading && (
							<p className="text-xs text-gray-10">Loading channels…</p>
						)}
						{hasDestinationsError && (
							<p className="text-xs text-red-11">
								We couldn’t load available channels. Reconnect the app and
								try again.
							</p>
						)}
						{!destinationsQuery.isLoading &&
							channelOptions.length === 0 &&
							isInstalled && (
								<p className="text-xs text-gray-10">
									Grant the integration access to at least one text channel to
									finish setup.
								</p>
							)}
					</ManagementPanelSection>
					<ManagementPanelSection title="Cap space">
						<Select
							placeholder="Select a space"
							disabled={!isInstalled}
							value={spaceId}
							onValueChange={(value) => setSpaceId(value)}
							options={spaceOptions}
						/>
						{spaceOptions.length === 0 && (
							<p className="text-xs text-gray-10">
								Create a space to start routing new videos to connected apps.
							</p>
						)}
					</ManagementPanelSection>
				</div>
			),
			actions: (
				<>
					<Button
						variant="dark"
						size="sm"
						onClick={handleSave}
						disabled={
							!isInstalled ||
							!hasChanges ||
							!channelId ||
							!spaceId ||
							updateSettingsMutation.isPending
						}
						spinner={updateSettingsMutation.isPending}
					>
						Save changes
					</Button>
					<Button
						variant="gray"
						size="sm"
						onClick={handleAuthorize}
						spinner={isAuthorizing}
					>
						{isInstalled ? "Reconnect" : "Connect"}
					</Button>
					<Button
						variant="gray"
						size="sm"
						onClick={isPaused ? handleResume : handlePause}
						disabled={
							!isInstalled ||
							pauseMutation.isPending ||
							resumeMutation.isPending
						}
						spinner={
							pauseMutation.isPending || resumeMutation.isPending
						}
					>
						{isPaused ? "Resume" : "Pause"}
					</Button>
					<Button
						variant="gray"
						size="sm"
						onClick={handleVerify}
						disabled={
							!isInstalled ||
							!channelId ||
							verifyDestinationMutation.isPending
						}
						spinner={verifyDestinationMutation.isPending}
					>
						Check permissions
					</Button>
					<Button
						variant="gray"
						size="sm"
						onClick={handleDispatchTest}
						disabled={!isConnected || dispatchTestMutation.isPending}
						spinner={dispatchTestMutation.isPending}
					>
						Send test post
					</Button>
					<Button
						variant="destructive"
						size="sm"
						onClick={handleUninstall}
						disabled={!isInstalled || uninstallMutation.isPending}
						spinner={uninstallMutation.isPending}
					>
						Uninstall
					</Button>
				</>
			),
			summary: summaryContent,
			side: sideContent,
		};
	},
);

export { DiscordManagementPanel };
