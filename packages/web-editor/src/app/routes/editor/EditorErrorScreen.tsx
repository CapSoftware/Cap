import { onMount } from "solid-js";
import IconAlertTriangle from "~icons/lucide/alert-triangle";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import {
	loadFailureMessage,
	reportEditorLoadFailure,
} from "../../../engine/editor-load-failure";
import { closeEditor } from "../../../engine/editor-window";
import { Button } from "../../../ui";

export function EditorErrorScreen(props: { error: unknown }) {
	onMount(() => {
		console.error("Editor failed to open", props.error);
		reportEditorLoadFailure(props.error);
	});
	return (
		<div class="flex flex-col flex-1 min-h-0">
			<div class="flex-1 flex items-center justify-center p-8">
				<div class="max-w-md w-full space-y-6">
					<div class="flex flex-col items-center text-center space-y-3">
						<div class="size-16 rounded-full bg-red-2 flex items-center justify-center">
							<IconAlertTriangle class="size-8 text-red-9" />
						</div>
						<h2 class="text-xl font-semibold text-gray-12">
							Unable to Open Recording
						</h2>
						<p role="alert" class="text-sm text-gray-11">
							{loadFailureMessage(props.error)}
						</p>
					</div>

					<Button
						onClick={() => window.location.reload()}
						variant="primary"
						class="w-full"
					>
						<IconRefreshCw class="size-4 mr-2" />
						Try again
					</Button>

					<div class="flex justify-center">
						<button
							type="button"
							onClick={() => void closeEditor()}
							class="text-sm text-gray-10 hover:text-gray-11 transition-colors"
						>
							Back to recording
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
