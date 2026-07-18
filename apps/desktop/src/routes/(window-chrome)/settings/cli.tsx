import { Button } from "@cap/ui-solid";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { createMemo, createResource, createSignal, Show } from "solid-js";
import toast from "solid-toast";
import { Section, SectionCard, SettingsPageContent } from "./Setting";

type CliInstallStatus = {
	installDir: string;
	shimPath: string;
	targetPath: string;
	installed: boolean;
	onPath: boolean;
	conflict: string | null;
	pathEntry: string;
	shellCommand: string;
	pathConfigured: boolean;
};

type McpServerConfig = {
	enabled: boolean;
	endpoint: string | null;
	token: string | null;
};

type McpTransport = "local" | "http";

const getCliInstallStatus = () =>
	invoke<CliInstallStatus>("get_cli_install_status");

const installCli = () => invoke<CliInstallStatus>("install_cli");

const uninstallCli = () => invoke<CliInstallStatus>("uninstall_cli");

const getMcpServerConfig = () =>
	invoke<McpServerConfig>("get_mcp_server_config");

const setMcpServerEnabled = (enabled: boolean) =>
	invoke<McpServerConfig>("set_mcp_server_enabled", { enabled });

const rotateMcpServerToken = () =>
	invoke<McpServerConfig>("rotate_mcp_server_token");

function errorMessage(error: unknown, fallback: string) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return fallback;
}

export default function CliSettings() {
	const [status, { refetch, mutate }] = createResource(getCliInstallStatus);
	const [mcpConfig, { refetch: refetchMcpConfig, mutate: mutateMcpConfig }] =
		createResource(getMcpServerConfig);
	const [isInstalling, setIsInstalling] = createSignal(false);
	const [isUninstalling, setIsUninstalling] = createSignal(false);
	const [isUpdatingMcp, setIsUpdatingMcp] = createSignal(false);
	const [isRotatingMcpToken, setIsRotatingMcpToken] = createSignal(false);
	const [mcpTransport, setMcpTransport] = createSignal<McpTransport>("local");
	const mcpCommand = createMemo(
		() =>
			(status()?.installed ? status()?.shimPath : status()?.targetPath) ??
			"cap",
	);
	const localMcpClientConfig = createMemo(() => {
		const command = mcpCommand();

		return JSON.stringify(
			{
				cap: {
					command,
					args: ["mcp"],
				},
			},
			null,
			2,
		);
	});
	const httpMcpClientConfig = (config: McpServerConfig) =>
		JSON.stringify(
			{
				cap: {
					url: config.endpoint,
					headers: {
						Authorization: `Bearer ${config.token}`,
					},
				},
			},
			null,
			2,
		);
	const selectedMcpClientConfig = (config: McpServerConfig) =>
		mcpTransport() === "local"
			? localMcpClientConfig()
			: httpMcpClientConfig(config);

	const installButtonLabel = () => {
		if (isInstalling())
			return status()?.installed ? "Repairing..." : "Installing...";
		return status()?.installed ? "Repair" : "Install CLI";
	};

	const handleInstall = async () => {
		setIsInstalling(true);

		try {
			mutate(await installCli());
			toast.success("Cap CLI installed");
		} catch (error) {
			toast.error(errorMessage(error, "Failed to install CLI"));
			await refetch();
		} finally {
			setIsInstalling(false);
		}
	};

	const handleUninstall = async () => {
		setIsUninstalling(true);

		try {
			mutate(await uninstallCli());
			toast.success("Cap CLI removed");
		} catch (error) {
			toast.error(errorMessage(error, "Failed to remove CLI"));
			await refetch();
		} finally {
			setIsUninstalling(false);
		}
	};

	const copyPathCommand = async (command: string) => {
		await writeText(command);
		toast.success("Copied to clipboard");
	};

	const handleMcpEnabledChange = async (enabled: boolean) => {
		setIsUpdatingMcp(true);

		try {
			mutateMcpConfig(await setMcpServerEnabled(enabled));
			toast.success(enabled ? "MCP server enabled" : "MCP server disabled");
		} catch (error) {
			toast.error(errorMessage(error, "Failed to update MCP server"));
			await refetchMcpConfig();
		} finally {
			setIsUpdatingMcp(false);
		}
	};

	const handleRotateMcpToken = async () => {
		setIsRotatingMcpToken(true);

		try {
			mutateMcpConfig(await rotateMcpServerToken());
			toast.success("MCP token rotated");
		} catch (error) {
			toast.error(errorMessage(error, "Failed to rotate MCP token"));
			await refetchMcpConfig();
		} finally {
			setIsRotatingMcpToken(false);
		}
	};

	const copyMcpClientConfig = async () => {
		const config = mcpConfig();
		if (!config) return;

		await writeText(selectedMcpClientConfig(config));
		toast.success("Copied MCP config");
	};

	return (
		<div class="cap-settings-page flex flex-col h-full custom-scroll">
			<SettingsPageContent>
				<Section
					title="Command Line"
					description="Install the Cap command for terminals, agents, scripts, and local automation."
				>
					<SectionCard padded>
						<Show
							when={!status.error && status()}
							fallback={
								<Show
									when={status.error}
									fallback={
										<div class="h-20 rounded-lg bg-gray-3 animate-pulse" />
									}
								>
									<div class="flex flex-col gap-2">
										<p class="text-xs leading-relaxed text-red-11">
											Couldn't load CLI status:{" "}
											{errorMessage(status.error, "unknown error")}
										</p>
										<Button
											size="sm"
											variant="gray"
											class="self-start"
											onClick={() => refetch()}
										>
											Retry
										</Button>
									</div>
								</Show>
							}
						>
							{(currentStatus) => (
								<div class="flex flex-col gap-4">
									<div class="flex items-start justify-between gap-4">
										<div class="flex flex-col gap-1 min-w-0">
											<p class="text-[13px] text-gray-12">
												{currentStatus().installed
													? "Installed"
													: "Not installed"}
											</p>
											<p class="text-xs leading-snug text-gray-10">
												The desktop app installs a local{" "}
												<code class="font-mono text-gray-12">cap</code> command
												that points back to the bundled CLI.
											</p>
										</div>
										<div class="flex shrink-0 gap-2">
											<Show when={currentStatus().installed}>
												<Button
													size="sm"
													variant="gray"
													disabled={isUninstalling()}
													onClick={handleUninstall}
												>
													{isUninstalling() ? "Removing..." : "Remove"}
												</Button>
											</Show>
											<Button
												size="sm"
												variant="dark"
												disabled={isInstalling()}
												onClick={handleInstall}
											>
												{installButtonLabel()}
											</Button>
										</div>
									</div>

									<div class="grid gap-2 text-xs">
										<PathRow label="Command" value={currentStatus().shimPath} />
										<PathRow
											label="Target"
											value={currentStatus().targetPath}
										/>
									</div>

									<Show when={currentStatus().conflict}>
										{(conflict) => (
											<p class="rounded-lg border border-red-300/40 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-11">
												{conflict()}
											</p>
										)}
									</Show>

									<Show
										when={currentStatus().installed && !currentStatus().onPath}
									>
										<div class="flex flex-col gap-2 rounded-lg border border-gray-4 bg-gray-3 px-3 py-3">
											<p class="text-xs leading-relaxed text-gray-10">
												<Show
													when={currentStatus().pathConfigured}
													fallback={
														<>
															Add{" "}
															<code class="font-mono text-gray-12">
																{currentStatus().pathEntry}
															</code>{" "}
															to your PATH to use{" "}
															<code class="font-mono text-gray-12">cap</code>{" "}
															from a new terminal.
														</>
													}
												>
													Added <code class="font-mono text-gray-12">cap</code>{" "}
													to your PATH. Restart your terminal to use it, or run
													this now:
												</Show>
											</p>
											<div class="flex items-center gap-2">
												<code class="flex-1 min-w-0 truncate rounded-md bg-gray-1 px-2 py-1.5 font-mono text-xs text-gray-12">
													{currentStatus().shellCommand}
												</code>
												<Button
													size="sm"
													variant="gray"
													onClick={() =>
														copyPathCommand(currentStatus().shellCommand)
													}
												>
													Copy
												</Button>
											</div>
										</div>
									</Show>
								</div>
							)}
						</Show>
					</SectionCard>
				</Section>

				<Section title="Model Context Protocol">
					<SectionCard padded>
						<Show
							when={!mcpConfig.error && mcpConfig()}
							fallback={
								<Show
									when={mcpConfig.error}
									fallback={
										<div class="h-24 rounded-lg bg-gray-3 animate-pulse" />
									}
								>
									<div class="flex flex-col gap-2">
										<p class="text-xs leading-relaxed text-red-11">
											Couldn't load MCP status:{" "}
											{errorMessage(mcpConfig.error, "unknown error")}
										</p>
										<Button
											size="sm"
											variant="gray"
											class="self-start"
											onClick={() => refetchMcpConfig()}
										>
											Retry
										</Button>
									</div>
								</Show>
							}
						>
							{(config) => (
								<div class="flex flex-col gap-4">
									<div class="flex items-start justify-between gap-4">
										<div class="flex flex-col gap-1 min-w-0">
											<p class="text-[13px] text-gray-12">
												{config().enabled ? "Enabled" : "Disabled"}
											</p>
										</div>
										<Button
											size="sm"
											variant={config().enabled ? "gray" : "dark"}
											disabled={isUpdatingMcp()}
											onClick={() => handleMcpEnabledChange(!config().enabled)}
										>
											{isUpdatingMcp()
												? "Updating..."
												: config().enabled
													? "Disable"
													: "Enable"}
										</Button>
									</div>

									<div class="grid grid-cols-2 self-start rounded-lg border border-gray-4 bg-gray-3 p-0.5">
										<button
											type="button"
											class="rounded-md px-3 py-1.5 text-xs text-gray-10 transition-colors"
											classList={{
												"bg-gray-1 text-gray-12": mcpTransport() === "local",
											}}
											onClick={() => setMcpTransport("local")}
										>
											Local
										</button>
										<button
											type="button"
											class="rounded-md px-3 py-1.5 text-xs text-gray-10 transition-colors"
											classList={{
												"bg-gray-1 text-gray-12": mcpTransport() === "http",
											}}
											onClick={() => setMcpTransport("http")}
										>
											HTTP
										</button>
									</div>

									<div class="grid gap-2 text-xs">
										<Show
											when={mcpTransport() === "local"}
											fallback={
												<PathRow
													label="Endpoint"
													value={config().endpoint ?? "Not running"}
												/>
											}
										>
											<PathRow label="Command" value={mcpCommand()} />
										</Show>
									</div>

									<div class="flex flex-col gap-2 rounded-lg border border-gray-4 bg-gray-3 px-3 py-3">
										<pre class="max-h-40 overflow-auto rounded-md bg-gray-1 px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-12">
											{selectedMcpClientConfig(config())}
										</pre>
										<div class="flex justify-end gap-2">
											<Button
												size="sm"
												variant="gray"
												disabled={!config().enabled}
												onClick={copyMcpClientConfig}
											>
												Copy config
											</Button>
											<Show when={config().enabled}>
												<Button
													size="sm"
													variant="gray"
													disabled={isRotatingMcpToken()}
													onClick={handleRotateMcpToken}
												>
													{isRotatingMcpToken()
														? "Rotating..."
														: "Rotate token"}
												</Button>
											</Show>
										</div>
									</div>
								</div>
							)}
						</Show>
					</SectionCard>
				</Section>
			</SettingsPageContent>
		</div>
	);
}

function PathRow(props: { label: string; value: string }) {
	return (
		<div class="flex items-center gap-3 min-w-0">
			<span class="w-16 shrink-0 text-gray-10">{props.label}</span>
			<code class="min-w-0 truncate rounded-md bg-gray-3 px-2 py-1 font-mono text-[11px] text-gray-12">
				{props.value}
			</code>
		</div>
	);
}
