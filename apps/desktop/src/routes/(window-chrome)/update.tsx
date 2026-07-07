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
			setUpdateError("Unable to check for updates.");
			return;
		}
	});

	return (
		<div class="flex flex-col justify-center flex-1 items-center gap-12 p-4 text-[0.875rem] font-normal h-full">
			<Show when={updateError()}>
				<div class="flex flex-col gap-4 items-center text-center max-w-md">
					<p class="text-(--text-primary)">{updateError()}</p>
					<p class="text-(--text-tertiary)">
						Please download the latest version manually from cap.so/download.
						Your data will not be lost.
					</p>
					<p class="text-(--text-tertiary) text-xs">
						If this issue persists, please contact support.
					</p>
					<Button onClick={() => navigate("/")}>Go Back</Button>
				</div>
			</Show>
			<Show
				when={!updateError() && update()}
				fallback={
					!updateError() && (
						<span class="text-(--text-tertiary)">No update available</span>
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
							setUpdateError("Failed to download or install the update.");
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
											Update has been installed. Restart Cap to finish updating.
										</p>
										<Button onClick={() => relaunch()}>Restart Now</Button>
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
											<h1 class="text-(--text-primary) mb-4">
												Installing Update
											</h1>

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
