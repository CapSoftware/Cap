import { Button } from "@cap/ui-solid";
import { useNavigate } from "@solidjs/router";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import {
	createResource,
	createSignal,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { commands, events } from "~/utils/tauri";

export default function () {
	const navigate = useNavigate();
	const [updateError, setUpdateError] = createSignal<string | null>(null);

	const [update] = createResource(async () => {
		try {
			const update = await commands.updatesCheck();
			if (!update) return;
			return update;
		} catch (e) {
			console.error("Failed to check for updates:", e);
			setUpdateError("无法检查更新。");
			return;
		}
	});

	return (
		<div class="flex flex-col justify-center flex-1 items-center gap-12 p-4 text-[0.875rem] font-normal h-full">
			<Show when={updateError()}>
				<div class="flex flex-col gap-4 items-center text-center max-w-md">
					<p class="text-(--text-primary)">{updateError()}</p>
					<p class="text-(--text-tertiary)">
						请前往 cap.so/download 手动下载最新版本。你的数据不会丢失。
					</p>
					<p class="text-(--text-tertiary) text-xs">
						如果问题仍然存在，请联系支持团队。
					</p>
					<Button onClick={() => navigate("/")}>返回</Button>
				</div>
			</Show>
			<Show
				when={!updateError() && update()}
				fallback={
					!updateError() && (
						<span class="text-(--text-tertiary)">暂无可用更新</span>
					)
				}
				keyed
			>
				{(_update) => {
					type UpdateStatus =
						| { type: "downloading"; progress: number; contentLength?: number }
						| { type: "done" };

					const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>();

					const unlisten = events.updateDownloadProgress.listen((e) => {
						if (updateStatus()?.type === "done") return;
						setUpdateStatus({
							type: "downloading",
							progress: e.payload.downloaded,
							contentLength: e.payload.total ?? undefined,
						});
					});
					onCleanup(() => {
						unlisten.then((cleanup) => cleanup());
					});

					commands
						.updatesDownloadAndInstall()
						.then(() => {
							setUpdateStatus({ type: "done" });
							getCurrentWindow().requestUserAttention(
								UserAttentionType.Informational,
							);
						})
						.catch((e) => {
							console.error("Failed to download/install update:", e);
							setUpdateError("下载或安装更新失败。");
						});

					return (
						<div>
							<Switch
								fallback={
									<IconCapLogo class="animate-spin size-4 text-(--text-primary)" />
								}
							>
								<Match when={updateStatus()?.type === "done"}>
									<div class="flex flex-col gap-4 items-center">
										<p class="text-(--text-tertiary)">
											更新已安装。请重启 Cap 以完成更新。
										</p>
										<Button onClick={() => relaunch()}>立即重启</Button>
									</div>
								</Match>
								<Match
									when={(() => {
										const s = updateStatus();
										if (
											s &&
											s.type === "downloading" &&
											s.contentLength !== undefined
										)
											return s;
									})()}
								>
									{(status) => (
										<>
											<h1 class="text-(--text-primary) mb-4">正在安装更新</h1>

											<div class="w-full bg-gray-3 rounded-full h-2.5">
												<div
													class="bg-blue-9 h-2.5 rounded-full"
													style={{
														width: `${Math.min(
															((status()?.progress ?? 0) /
																(status()?.contentLength ?? 0)) *
																100,
															100,
														)}%`,
													}}
												/>
											</div>
										</>
									)}
								</Match>
							</Switch>
						</div>
					);
				}}
			</Show>
		</div>
	);
}
