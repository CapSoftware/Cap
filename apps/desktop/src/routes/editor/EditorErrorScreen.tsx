import { Button } from "@cap/ui-solid";
import { createMutation } from "@tanstack/solid-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type as ostype } from "@tauri-apps/plugin-os";
import { createEffect, onCleanup, Show } from "solid-js";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import { createTauriEventListener } from "~/utils/createEventListener";
import { isRecordingStorageError } from "~/utils/recording";
import { commands } from "~/utils/tauri";
import IconAlertTriangle from "~icons/lucide/alert-triangle";
import IconFolder from "~icons/lucide/folder";
import IconLoaderCircle from "~icons/lucide/loader-circle";
import IconRefreshCw from "~icons/lucide/refresh-cw";

const NEEDS_RECOVERY_PATTERN = /may need to be recovered/i;

function isRecoveryNeededError(error: string): boolean {
	return NEEDS_RECOVERY_PATTERN.test(error);
}

export function EditorErrorScreen(props: {
	error: string;
	projectPath: string;
}) {
	const storageShortage = () => isRecordingStorageError(props.error);
	const needsRecovery = () =>
		storageShortage() || isRecoveryNeededError(props.error);
	const isMac = () => ostype() === "macos";

	let disposed = false;
	let listening = false;
	let checkAfterPending = false;
	let queryRequest = 0;
	let recoveryRequest = 0;
	let activeProjectPath = props.projectPath;

	const successStorageKey = (projectPath: string) =>
		`cap:recording-recovery-success:${projectPath}`;

	const isCurrentRecovery = (projectPath: string, request: number) =>
		!disposed &&
		props.projectPath === projectPath &&
		recoveryRequest === request;

	const recoverMutation = createMutation(() => ({
		onMutate: () => {
			queryRequest += 1;
			checkAfterPending = false;
		},
		mutationFn: async ({
			projectPath,
			request,
		}: {
			projectPath: string;
			request: number;
		}) => {
			if (!isCurrentRecovery(projectPath, request)) return projectPath;
			const result = await commands.recoverRecording(projectPath);
			if (!isCurrentRecovery(projectPath, request)) return result;
			await commands.showWindow({ Editor: { project_path: result } });
			return result;
		},
		onSuccess: async (_result, { projectPath, request }) => {
			if (!isCurrentRecovery(projectPath, request)) return;
			queryRequest += 1;
			checkAfterPending = false;
			try {
				const successId = await invoke<string | null>(
					"get_recording_recovery_success",
					{ projectPath },
				);
				if (!isCurrentRecovery(projectPath, request)) return;
				if (typeof successId === "string" && successId.length > 0) {
					window.sessionStorage.setItem(
						successStorageKey(projectPath),
						successId,
					);
				}
			} catch (error) {
				console.error("Failed to remember recording recovery", error);
			}
			if (!isCurrentRecovery(projectPath, request)) return;
			queryRequest += 1;
			checkAfterPending = false;
			window.location.reload();
		},
	}));

	const checkRecoverySuccess = async (projectPath: string) => {
		if (disposed || !listening || projectPath !== props.projectPath) return;
		if (recoverMutation.isPending) {
			checkAfterPending = true;
			return;
		}
		const request = ++queryRequest;
		try {
			const successId = await invoke<string | null>(
				"get_recording_recovery_success",
				{ projectPath },
			);
			if (
				disposed ||
				request !== queryRequest ||
				projectPath !== props.projectPath
			)
				return;
			if (recoverMutation.isPending) {
				checkAfterPending = true;
				return;
			}
			if (typeof successId !== "string" || successId.length === 0) return;
			const key = successStorageKey(projectPath);
			if (window.sessionStorage.getItem(key) === successId) return;
			window.sessionStorage.setItem(key, successId);
			window.location.reload();
		} catch (error) {
			console.error("Failed to check recording recovery", error);
		}
	};

	createTauriEventListener<string>(
		{
			listen: (callback) =>
				listen<string>("recording-recovery-completed", callback)
					.then((unlisten) => {
						if (!disposed) {
							listening = true;
							void checkRecoverySuccess(props.projectPath);
						}
						return unlisten;
					})
					.catch((error: unknown) => {
						console.error("Failed to listen for recording recovery", error);
						return () => undefined;
					}),
		},
		() => {
			listening = true;
			void checkRecoverySuccess(props.projectPath);
		},
	);

	createEffect(() => {
		const projectPath = props.projectPath;
		const pending = recoverMutation.isPending;
		if (projectPath !== activeProjectPath) {
			activeProjectPath = projectPath;
			queryRequest += 1;
			recoveryRequest += 1;
			checkAfterPending = false;
			void checkRecoverySuccess(projectPath);
		} else if (!pending && checkAfterPending) {
			checkAfterPending = false;
			void checkRecoverySuccess(projectPath);
		}
	});

	onCleanup(() => {
		disposed = true;
		queryRequest += 1;
		recoveryRequest += 1;
		checkAfterPending = false;
	});

	const handleOpenFolder = () => {
		revealItemInDir(props.projectPath);
	};

	return (
		<div class="flex flex-col flex-1 min-h-0">
			<div
				data-tauri-drag-region
				class="flex relative flex-row items-center w-full h-14 px-4"
			>
				{isMac() && <div class="h-full w-16" />}
				<div data-tauri-drag-region class="flex-1 h-full" />
				{ostype() === "windows" && <CaptionControlsWindows11 />}
			</div>

			<div class="flex-1 flex items-center justify-center p-8">
				<div class="max-w-md w-full space-y-6">
					<div class="flex flex-col items-center text-center space-y-3">
						<div class="size-16 rounded-full bg-red-2 flex items-center justify-center">
							<IconAlertTriangle class="size-8 text-red-9" />
						</div>
						<h2 class="text-xl font-semibold text-gray-12">
							{storageShortage()
								? "More space needed"
								: needsRecovery()
									? "Recording Needs Recovery"
									: "Unable to Open Recording"}
						</h2>
						<p class="text-sm text-gray-11">{props.error}</p>
					</div>

					<Show when={needsRecovery()}>
						<div class="bg-gray-2 border border-gray-4 rounded-xl p-4 space-y-4">
							<div class="space-y-2">
								<h3 class="font-medium text-gray-12 text-sm">
									{storageShortage()
										? "Finish saving your recording"
										: "Automatic Recovery"}
								</h3>
								<p class="text-xs text-gray-11">
									{storageShortage()
										? "Free up space on the recording drive, then click Recover Recording. Your recording files have been kept."
										: "Cap can attempt to recover your recording automatically. This will reconstruct the recording from available segment data."}
								</p>
							</div>

							<Button
								onClick={() =>
									recoverMutation.mutate({
										projectPath: props.projectPath,
										request: ++recoveryRequest,
									})
								}
								disabled={recoverMutation.isPending}
								variant="primary"
								class="w-full"
							>
								<Show
									when={recoverMutation.isPending}
									fallback={
										<>
											<IconRefreshCw class="size-4 mr-2" />
											Recover Recording
										</>
									}
								>
									<IconLoaderCircle class="size-4 mr-2 animate-spin" />
									Recovering...
								</Show>
							</Button>

							<Show when={recoverMutation.error}>
								<div class="bg-red-2 border border-red-6 rounded-lg p-3">
									<p class="text-red-11 text-xs">
										Recovery failed:{" "}
										{recoverMutation.error instanceof Error
											? recoverMutation.error.message
											: String(recoverMutation.error)}
									</p>
								</div>
							</Show>
						</div>
					</Show>

					<div class="bg-gray-2 border border-gray-4 rounded-xl p-4 space-y-4">
						<div class="space-y-2">
							<h3 class="font-medium text-gray-12 text-sm">
								Manual Investigation
							</h3>
							<p class="text-xs text-gray-11">
								You can open the recording folder to inspect the raw files
								directly.
							</p>

							<div class="bg-gray-3 rounded-lg p-3 space-y-2">
								<p class="text-xs font-mono text-gray-11 break-all">
									{props.projectPath}
								</p>
								<Show
									when={isMac()}
									fallback={
										<p class="text-xs text-gray-10 italic">
											Tip: Double-click inside the folder to browse the
											contents.
										</p>
									}
								>
									<p class="text-xs text-gray-10 italic">
										Tip: Right-click and select "Show Enclosing Folder" to see
										the .cap bundle contents.
									</p>
								</Show>
							</div>
						</div>

						<Button onClick={handleOpenFolder} variant="outline" class="w-full">
							<IconFolder class="size-4 mr-2" />
							Open Folder
						</Button>
					</div>

					<div class="flex justify-center">
						<button
							type="button"
							onClick={() => window.close()}
							class="text-sm text-gray-10 hover:text-gray-11 transition-colors"
						>
							Close Window
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
