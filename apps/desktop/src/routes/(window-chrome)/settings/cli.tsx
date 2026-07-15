import { Button } from "@cap/ui-solid";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { createResource, createSignal, Show } from "solid-js";
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

const getCliInstallStatus = () =>
	invoke<CliInstallStatus>("get_cli_install_status");

const installCli = () => invoke<CliInstallStatus>("install_cli");

const uninstallCli = () => invoke<CliInstallStatus>("uninstall_cli");

function errorMessage(error: unknown, fallback: string) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return fallback;
}

export default function CliSettings() {
	const [status, { refetch, mutate }] = createResource(getCliInstallStatus);
	const [isInstalling, setIsInstalling] = createSignal(false);
	const [isUninstalling, setIsUninstalling] = createSignal(false);

	const installButtonLabel = () => {
		if (isInstalling())
			return status()?.installed ? "正在修复……" : "正在安装……";
		return status()?.installed ? "修复" : "安装 CLI";
	};

	const handleInstall = async () => {
		setIsInstalling(true);

		try {
			mutate(await installCli());
			toast.success("Cap CLI 已安装");
		} catch (error) {
			toast.error(errorMessage(error, "安装 CLI 失败"));
			await refetch();
		} finally {
			setIsInstalling(false);
		}
	};

	const handleUninstall = async () => {
		setIsUninstalling(true);

		try {
			mutate(await uninstallCli());
			toast.success("Cap CLI 已移除");
		} catch (error) {
			toast.error(errorMessage(error, "移除 CLI 失败"));
			await refetch();
		} finally {
			setIsUninstalling(false);
		}
	};

	const copyPathCommand = async (command: string) => {
		await writeText(command);
		toast.success("已复制到剪贴板");
	};

	return (
		<div class="cap-settings-page flex flex-col h-full custom-scroll">
			<SettingsPageContent>
				<Section
					title="命令行"
					description="安装可在终端、智能体、脚本和本地自动化中使用的 Cap 命令。"
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
											无法加载 CLI 状态：{" "}
											{errorMessage(status.error, "未知错误")}
										</p>
										<Button
											size="sm"
											variant="gray"
											class="self-start"
											onClick={() => refetch()}
										>
											重试
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
												{currentStatus().installed ? "已安装" : "未安装"}
											</p>
											<p class="text-xs leading-snug text-gray-10">
												桌面应用会安装本地{" "}
												<code class="font-mono text-gray-12">cap</code> 命令
												命令，并指向应用内置的 CLI。
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
													{isUninstalling() ? "正在移除……" : "移除"}
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
										<PathRow label="命令" value={currentStatus().shimPath} />
										<PathRow label="目标" value={currentStatus().targetPath} />
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
															将{" "}
															<code class="font-mono text-gray-12">
																{currentStatus().pathEntry}
															</code>{" "}
															添加到 PATH，即可在新终端中使用{" "}
															<code class="font-mono text-gray-12">cap</code>{" "}
															命令。
														</>
													}
												>
													已将 <code class="font-mono text-gray-12">cap</code>{" "}
													添加到 PATH。重启终端后即可使用，或者现在运行：
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
													复制
												</Button>
											</div>
										</div>
									</Show>
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
