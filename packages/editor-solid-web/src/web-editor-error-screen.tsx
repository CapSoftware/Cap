import { Button } from "@cap/ui-solid";
import { Show } from "solid-js";
import IconAlertTriangle from "~icons/lucide/alert-triangle";
import IconRefreshCw from "~icons/lucide/refresh-cw";

export type WebEditorErrorAction =
	| "retry"
	| "restore-browser"
	| "open-latest"
	| "back-to-recording";

export function WebEditorErrorScreen(props: {
	message: string;
	hasBrowserDraftConflict: boolean;
	restoringBrowserDraft: boolean;
	onAction: (action: WebEditorErrorAction) => void;
}) {
	return (
		<div class="flex min-h-0 flex-1 flex-col">
			<div class="relative flex h-14 w-full flex-row items-center px-4">
				<div class="h-full w-16" />
				<div class="h-full flex-1" />
			</div>
			<div class="flex flex-1 items-center justify-center p-8">
				<div class="w-full max-w-md space-y-6">
					<div class="flex flex-col items-center space-y-3 text-center">
						<div class="flex size-16 items-center justify-center rounded-full bg-red-2">
							<IconAlertTriangle class="size-8 text-red-9" />
						</div>
						<h2 class="text-xl font-semibold text-gray-12">
							Unable to Open Recording
						</h2>
						<p role="alert" class="text-sm text-gray-11">
							{props.message}
						</p>
					</div>
					<Show
						when={props.hasBrowserDraftConflict}
						fallback={
							<Button
								onClick={() => props.onAction("retry")}
								variant="primary"
								class="w-full"
							>
								<IconRefreshCw class="mr-2 size-4" />
								Try again
							</Button>
						}
					>
						<div class="space-y-4 rounded-xl border border-gray-4 bg-gray-2 p-4">
							<div class="space-y-2">
								<h3 class="text-sm font-medium text-gray-12">
									Saved browser edits
								</h3>
								<p class="text-xs text-gray-11">
									Choose which version of the recording to open.
								</p>
							</div>
							<Button
								onClick={() => props.onAction("restore-browser")}
								disabled={props.restoringBrowserDraft}
								variant="primary"
								class="w-full"
							>
								{props.restoringBrowserDraft
									? "Restoring browser edits…"
									: "Restore browser edits"}
							</Button>
							<Button
								onClick={() => props.onAction("open-latest")}
								disabled={props.restoringBrowserDraft}
								variant="outline"
								class="w-full"
							>
								Open latest saved
							</Button>
						</div>
					</Show>
					<div class="flex justify-center">
						<button
							type="button"
							onClick={() => props.onAction("back-to-recording")}
							class="text-sm text-gray-10 transition-colors hover:text-gray-11"
						>
							Back to recording
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
