import { Button } from "@cap/ui-solid";
import { useNavigate } from "@solidjs/router";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { createResource, createSignal, Match, Show, Switch } from "solid-js";
import { generalSettingsStore } from "~/store";

export default function () {
	const navigate = useNavigate();
	const [updateError, setUpdateError] = createSignal<string | null>(null);
	const [updatesDisabled, setUpdatesDisabled] = createSignal<boolean>(false);

	const [update] = createResource(async () => {
		try {
			const generalSettings = await generalSettingsStore.get();
			
			if (generalSettings?.disableUpdateChecks ?? false) {
				setUpdatesDisabled(true);
				return;
			}
			
			const update = await check();
			if (!update) return;
			return update;
		} catch (e) {
			console.error("Failed to check for updates:", e);
			setUpdateError("Unable to check for updates.");
			return;
		}
	});

	return (
		<div class="flex flex-col justify-center flex-1 items-center gap-[3rem] p-[1rem] text-[0.875rem] font-[400] h-full">
			<Show when={updatesDisabled()}>
			    <div class="flex flex-col gap-4 items-center text-center max-w-md">
					<p class="text-[--text-primary]">Update checks are currently disabled.</p>
					<p class="text-[--text-tertiary]">
						To enable updates, go to General Settings and disable "Disable Update Checks".
					</p>
			        <Button onClick={() => navigate("/")}>Go Back</Button>
			    </div>
			</Show>
			<Show when={updateError()}>
				<div class="flex flex-col gap-4 items-center text-center max-w-md">
					<p class="text-[--text-primary]">{updateError()}</p>
					<p class="text-[--text-tertiary]">
						Please download the latest version manually from cap.so/download.
						Your data will not be lost.
					</p>
					<p class="text-[--text-tertiary] text-xs">
						If this issue persists, please contact support.
					</p>
					<Button onClick={() => navigate("/")}>Go Back</Button>
				</div>
			</Show>
			<Show
				when={!updateError() && update()}
				fallback={
					!updateError() && !updatesDisabled() && (
						<span class="text-[--text-tertiary]">No update available</span>
					)
				}
				keyed
			>
				{(update) => {
					type UpdateStatus =
						| { type: "downloading"; progress: number; contentLength?: number }
						| { type: "done" };

					const [updateStatus, updateStatusActions] =
						createResource<UpdateStatus>(
							() =>
								new Promise<UpdateStatus>((resolve) => {
									update
										.downloadAndInstall((e) => {
											if (e.event === "Started") {
												resolve({
													type: "downloading",
													progress: 0,
													contentLength: e.data.contentLength,
												});
											} else if (e.event === "Progress") {
												const status = updateStatus();
												if (
													!status ||
													status.type !== "downloading" ||
													status.contentLength === undefined
												)
													return;
												updateStatusActions.mutate({
													...status,
													progress: e.data.chunkLength + status.progress,
												});
											}
										})
										.then(async () => {
											updateStatusActions.mutate({ type: "done" });
											getCurrentWindow().requestUserAttention(
												UserAttentionType.Informational,
											);
										})
										.catch((e) => {
											console.error("Failed to download/install update:", e);
											setUpdateError(
												"Failed to download or install the update.",
											);
										});
								}),
						);

					return (
						<div>
							<Switch
								fallback={
									<IconCapLogo class="animate-spin size-4 text-[--text-primary]" />
								}
							>
								<Match when={updateStatus()?.type === "done"}>
									<div class="flex flex-col gap-4 items-center">
										<p class="text-[--text-tertiary]">
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
											<h1 class="text-[--text-primary] mb-4">
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
