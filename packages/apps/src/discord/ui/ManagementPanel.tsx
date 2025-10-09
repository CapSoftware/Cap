"use client";

import { Button, Select } from "@cap/ui";
import { formatDistanceToNow } from "date-fns";
import { Cause, Effect, Exit, Option } from "effect";
import { useEffect, useMemo, useState } from "react";

import {
	AppStatusBadge,
	type AppStatusKey,
} from "../../ui/components/AppStatusBadge.tsx";
import { useAppsUi } from "../../ui/context.tsx";
import type {
	AppDestinationType,
	AppInstallationViewType,
	AppManagementComponentProps,
} from "../../ui/types.ts";

const EMPTY_SELECTION = "";

const DiscordManagementPanel = ({
	selection,
	spaces,
	onClose,
	onSelectionChange,
}: AppManagementComponentProps) => {
	const { useEffectQuery, useEffectMutation, useQueryClient, toast, withRpc } =
		useAppsUi();

	const queryClient = useQueryClient();
	const isInstalled = selection.installation !== null;
	const status: AppStatusKey = selection.installation
		? selection.installation.status
		: "not_installed";

	const destinationsQuery = useEffectQuery<AppDestinationType[], unknown, true>(
		{
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
		},
	);

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

	const handleSave = async () => {
		if (disableConfiguration) return;
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

	const isConnected = status === "connected";
	const isPaused = status === "paused";
	const needsAttention = status === "needs_attention";

	const lastCheckedLabel = selection.installation
		? Option.match(selection.installation.lastCheckedAt, {
				onNone: () => null,
				onSome: (date) => formatDistanceToNow(date, { addSuffix: true }),
			})
		: null;

	const disableConfiguration = !isInstalled;

	return (
		<section className="rounded-2xl border border-gray-4 bg-gray-1 p-6 shadow-sm">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="flex flex-col gap-2">
					<h2 className="text-xl font-semibold leading-tight text-gray-12">
						Manage {selection.definition.displayName}
					</h2>
					<p className="text-sm text-gray-11">
						Configure destinations, toggle automation, and send test posts
						without leaving the dashboard.
					</p>
					<div className="flex flex-wrap items-center gap-3">
						<AppStatusBadge status={status} />
						{lastCheckedLabel && (
							<span className="text-xs uppercase tracking-wide text-gray-9">
								Last checked {lastCheckedLabel}
							</span>
						)}
					</div>
				</div>
				<Button variant="white" size="sm" onClick={onClose}>
					Close
				</Button>
			</header>

			<div className="mt-6 grid gap-6 md:grid-cols-2">
				<div className="flex flex-col gap-2">
					<label
						htmlFor="channel-select"
						className="text-sm font-medium text-gray-12"
					>
						Destination channel
					</label>
					<div className="flex flex-col gap-2">
						<Select
							placeholder={
								needsAttention
									? "Reconnect to load channels"
									: "Select a channel"
							}
							disabled={disableConfiguration || destinationsQuery.isLoading}
							value={channelId}
							onValueChange={(value) => setChannelId(value)}
							options={channelOptions}
						/>
						{destinationsQuery.isLoading && (
							<p className="text-xs text-gray-10">Loading channels…</p>
						)}
						{hasDestinationsError && (
							<p className="text-xs text-red-11">
								We couldn&apos;t load available channels. Reconnect the app and
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
					</div>
				</div>

				<div className="flex flex-col gap-2">
					<label
						htmlFor="space-select"
						className="text-sm font-medium text-gray-12"
					>
						Cap space
					</label>
					<Select
						placeholder="Select a space"
						disabled={disableConfiguration}
						value={spaceId}
						onValueChange={(value) => setSpaceId(value)}
						options={spaceOptions}
					/>
					{spaceOptions.length === 0 && (
						<p className="text-xs text-gray-10">
							Create a space to start routing new videos to connected apps.
						</p>
					)}
				</div>
			</div>

			<div className="mt-6 flex flex-wrap items-center gap-3">
				<Button
					variant="dark"
					size="sm"
					onClick={handleSave}
					disabled={
						disableConfiguration ||
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
						!isInstalled || pauseMutation.isPending || resumeMutation.isPending
					}
					spinner={pauseMutation.isPending || resumeMutation.isPending}
				>
					{isPaused ? "Resume" : "Pause"}
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
			</div>

			<div className="mt-6 rounded-xl border border-gray-4 bg-gray-2 p-4 text-sm text-gray-11">
				{isInstalled ? (
					selectedSpaceLabel && selectedChannelLabel ? (
						<p>
							New videos shared to{" "}
							<span className="font-medium text-gray-12">
								{selectedSpaceLabel}
							</span>{" "}
							will post in{" "}
							<span className="font-medium text-gray-12">
								{selectedChannelLabel}
							</span>
							.
						</p>
					) : (
						<p>Select a space and channel to control where automations run.</p>
					)
				) : (
					<p>
						Connect {selection.definition.displayName} to choose a destination
						channel and start sharing recordings automatically.
					</p>
				)}
			</div>
		</section>
	);
};

export { DiscordManagementPanel };
