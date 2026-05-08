import { Button } from "@cap/ui-solid";
import { useMutation } from "@tanstack/solid-query";
import { createResource, createSignal, Show, Suspense } from "solid-js";
import { commands } from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";
import { IntegrationConfigHeader } from "./config-header";

const byteUnits = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const googleDriveConnectionPollIntervalMs = 1500;
const googleDriveConnectionPollTimeoutMs = 120000;

const formatBytes = (value?: string | null) => {
	if (!value) return null;

	const bytes = Number(value);
	if (!Number.isFinite(bytes)) return null;
	if (bytes === 0) return "0 B";

	let size = bytes;
	let unitIndex = 0;
	while (size >= 1024 && unitIndex < byteUnits.length - 1) {
		size /= 1024;
		unitIndex += 1;
	}

	const decimals = size >= 10 || unitIndex === 0 ? 0 : 1;
	return `${size.toFixed(decimals)} ${byteUnits[unitIndex]}`;
};

const formatTimestamp = (value: string) => {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;

	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
};

const wait = (ms: number) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const fetchStorageIntegrations = async (refreshStorageQuota = false) => {
	const response = await apiClient.desktop.getStorageIntegrations({
		query: refreshStorageQuota ? { refreshStorageQuota: true } : undefined,
		headers: await protectedHeaders(),
	});

	if (response.status !== 200)
		throw new Error("Failed to fetch storage integrations");

	return response.body;
};

const fetchS3Config = async () => {
	const response = await apiClient.desktop.getS3Config({
		headers: await protectedHeaders(),
	});

	if (response.status !== 200) throw new Error("Failed to fetch S3 config");

	return response.body.config;
};

export default function GoogleDriveConfigPage() {
	const [isWaitingForConnection, setIsWaitingForConnection] =
		createSignal(false);
	const [isRefreshing, setIsRefreshing] = createSignal(false);
	const [storage, { mutate: setStorage }] = createResource(() =>
		fetchStorageIntegrations(),
	);

	const googleDrive = () => storage()?.googleDrive;
	const storageQuota = () => googleDrive()?.storageQuota ?? null;
	const isConnected = () => googleDrive()?.connected === true;
	const isActive = () => storage()?.activeProvider === "googleDrive";

	const [s3Config, { mutate: setS3Config }] = createResource(fetchS3Config);

	const hasS3Config = () => {
		const config = s3Config();
		return !!config?.accessKeyId && !!config.bucketName;
	};

	const updateStorage = async (refreshStorageQuota = false) => {
		const nextStorage = await fetchStorageIntegrations(refreshStorageQuota);
		setStorage(nextStorage);
		return nextStorage;
	};

	const updateS3Config = async () => {
		const nextConfig = await fetchS3Config();
		setS3Config(nextConfig);
		return nextConfig;
	};

	const refetch = async () => {
		setIsRefreshing(true);
		await Promise.all([updateStorage(true), updateS3Config()]).finally(() => {
			setIsRefreshing(false);
		});
	};

	const quotaUsageLabel = () => {
		const quota = storageQuota();
		const usage = formatBytes(quota?.usage);
		if (!quota || !usage) return null;

		const limit = formatBytes(quota.limit);
		return limit ? `${usage} of ${limit} used` : `${usage} used`;
	};

	const quotaUsagePercent = () => {
		const quota = storageQuota();
		if (!quota?.limit || !quota.usage) return null;

		const limit = Number(quota.limit);
		const usage = Number(quota.usage);
		if (!Number.isFinite(limit) || !Number.isFinite(usage) || limit <= 0)
			return null;

		return Math.min(Math.max((usage / limit) * 100, 0), 100);
	};

	const quotaTimestampLabel = () => {
		const quota = storageQuota();
		if (!quota) return null;

		const timestamp = formatTimestamp(quota.fetchedAt);
		if (!timestamp) return null;

		return `${quota.stale ? "Cached" : "Updated"} ${timestamp}`;
	};

	const waitForGoogleDriveConnection = async () => {
		setIsWaitingForConnection(true);
		try {
			const timeoutAt = Date.now() + googleDriveConnectionPollTimeoutMs;
			while (Date.now() < timeoutAt) {
				await wait(googleDriveConnectionPollIntervalMs);
				const nextStorage = await updateStorage();
				if (nextStorage?.googleDrive.connected) {
					await updateS3Config();
					return;
				}
			}
			await commands.globalMessageDialog(
				"Finish connecting Google Drive in your browser, then return here and refresh.",
			);
		} finally {
			setIsWaitingForConnection(false);
		}
	};

	const connect = useMutation(() => ({
		mutationFn: async () => {
			const response = await apiClient.desktop.connectGoogleDriveStorage({
				body: {},
				headers: await protectedHeaders(),
			});

			if (response.status === 403) {
				await commands.showWindow("Upgrade");
				return null;
			}

			if (response.status !== 200)
				throw new Error("Failed to start Google Drive connection");

			await commands.openExternalLink(response.body.url);
			return response.body;
		},
		onSuccess: (body) => {
			if (!body) return;
			waitForGoogleDriveConnection().catch((error) => {
				console.error("Failed to wait for Google Drive connection:", error);
			});
		},
	}));

	const testConnection = useMutation(() => ({
		mutationFn: async () => {
			const response = await apiClient.desktop.testGoogleDriveStorage({
				body: {},
				headers: await protectedHeaders(),
			});

			if (response.status !== 200)
				throw new Error("Google Drive connection test failed");

			return response.body;
		},
		onSuccess: async (body) => {
			await commands.globalMessageDialog(
				body.email
					? `Google Drive connection is working for ${body.email}`
					: "Google Drive connection is working",
			);
		},
	}));

	const setActive = useMutation(() => ({
		mutationFn: async (provider: "s3" | "googleDrive") => {
			const response = await apiClient.desktop.setActiveStorageProvider({
				body: { provider },
				headers: await protectedHeaders(),
			});

			if (response.status !== 200)
				throw new Error("Failed to update active storage provider");

			return response.body;
		},
		onSuccess: async () => {
			await refetch();
		},
	}));

	const disconnect = useMutation(() => ({
		mutationFn: async () => {
			const response = await apiClient.desktop.disconnectGoogleDriveStorage({
				headers: await protectedHeaders(),
			});

			if (response.status !== 200)
				throw new Error("Failed to disconnect Google Drive");

			return response.body;
		},
		onSuccess: async () => {
			await refetch();
			await commands.globalMessageDialog("Google Drive disconnected");
		},
	}));

	const busy = () =>
		storage.loading ||
		s3Config.loading ||
		isRefreshing() ||
		connect.isPending ||
		isWaitingForConnection() ||
		testConnection.isPending ||
		setActive.isPending ||
		disconnect.isPending;

	return (
		<div class="flex flex-col p-4 h-full">
			<IntegrationConfigHeader title="Google Drive" />
			<div class="rounded-xl border bg-gray-2 border-gray-4 custom-scroll">
				<div class="flex-1">
					<Suspense
						fallback={
							<div class="flex justify-center items-center w-full h-screen">
								<IconCapLogo class="animate-spin size-16" />
							</div>
						}
					>
						<div class="p-4 space-y-4 animate-in fade-in">
							<div class="pb-4 border-b border-gray-3">
								<p class="text-sm text-gray-11">
									Google Drive stores new uploads in a private Cap folder in
									your Drive. Existing Cap-hosted and S3 videos keep using their
									current storage.
								</p>
							</div>

							<div class="space-y-3">
								<div class="flex justify-between items-start gap-4">
									<div>
										<p class="text-sm font-medium text-gray-12">
											{isConnected()
												? googleDrive()?.displayName
												: "Google Drive"}
										</p>
										<p class="text-[13px] text-gray-10">
											{isConnected()
												? isActive()
													? "Active for new uploads"
													: "Connected but not active"
												: "Not connected"}
										</p>
									</div>
									<Button
										variant="gray"
										disabled={busy()}
										onClick={() => refetch()}
									>
										{isRefreshing() ? "Refreshing..." : "Refresh"}
									</Button>
								</div>

								<Show
									when={isConnected()}
									fallback={
										<Button
											variant="primary"
											disabled={busy()}
											onClick={() => connect.mutate()}
										>
											{isWaitingForConnection()
												? "Waiting..."
												: connect.isPending
													? "Opening..."
													: "Connect Google Drive"}
										</Button>
									}
								>
									<Show when={storageQuota()}>
										<div class="pt-3 space-y-2 border-t border-gray-3">
											<div class="flex justify-between items-start gap-4">
												<div>
													<p class="text-[13px] font-medium text-gray-12">
														Storage
													</p>
													<Show when={quotaUsageLabel()}>
														{(label) => (
															<p class="text-[13px] text-gray-10">{label()}</p>
														)}
													</Show>
												</div>
												<Show when={quotaTimestampLabel()}>
													{(label) => (
														<p class="text-[12px] text-gray-9 text-right">
															{label()}
														</p>
													)}
												</Show>
											</div>
											<Show when={quotaUsagePercent() !== null}>
												<div class="overflow-hidden h-1.5 rounded-full bg-gray-4">
													<div
														class="h-full rounded-full bg-blue-9"
														style={{
															width: `${quotaUsagePercent() ?? 0}%`,
														}}
													/>
												</div>
											</Show>
											<div class="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
												<Show when={formatBytes(storageQuota()?.remaining)}>
													{(remaining) => (
														<>
															<p class="text-gray-10">Remaining</p>
															<p class="text-right text-gray-11">
																{remaining()}
															</p>
														</>
													)}
												</Show>
												<Show when={formatBytes(storageQuota()?.usageInDrive)}>
													{(usageInDrive) => (
														<>
															<p class="text-gray-10">Drive files</p>
															<p class="text-right text-gray-11">
																{usageInDrive()}
															</p>
														</>
													)}
												</Show>
												<Show
													when={formatBytes(storageQuota()?.usageInDriveTrash)}
												>
													{(usageInDriveTrash) => (
														<>
															<p class="text-gray-10">Trash</p>
															<p class="text-right text-gray-11">
																{usageInDriveTrash()}
															</p>
														</>
													)}
												</Show>
											</div>
										</div>
									</Show>
									<div class="flex flex-wrap gap-2">
										<Button
											variant="primary"
											disabled={busy() || isActive()}
											onClick={() => setActive.mutate("googleDrive")}
										>
											{isActive() ? "Active" : "Use Google Drive"}
										</Button>
										<Show when={hasS3Config()}>
											<Button
												variant="gray"
												disabled={busy() || !isActive()}
												onClick={() => setActive.mutate("s3")}
											>
												Use S3
											</Button>
										</Show>
										<Button
											variant="gray"
											disabled={busy()}
											onClick={() => testConnection.mutate()}
										>
											{testConnection.isPending ? "Testing..." : "Test"}
										</Button>
										<Button
											variant="destructive"
											disabled={busy()}
											onClick={() => disconnect.mutate()}
										>
											Disconnect
										</Button>
									</div>
								</Show>
							</div>
						</div>
					</Suspense>
				</div>
			</div>
		</div>
	);
}
