import { Button } from "@cap/ui-solid";
import { createMutation, createQuery } from "@tanstack/solid-query";
import { createSignal, Show } from "solid-js";
import { commands } from "~/utils/tauri";

function formatDuration(secs: number): string {
	if (secs < 60) {
		return `${Math.round(secs)}s`;
	}
	const mins = Math.floor(secs / 60);
	const remainingSecs = Math.round(secs % 60);
	if (remainingSecs === 0) {
		return `${mins}m`;
	}
	return `${mins}m ${remainingSecs}s`;
}

export function RecoveryToast() {
	const [dismissed] = createSignal(false);

	const incompleteRecordings = createQuery(() => ({
		queryKey: ["incompleteRecordings"],
		queryFn: () => commands.findIncompleteRecordings(),
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
	}));

	const mostRecent = () => {
		const data = incompleteRecordings.data;
		if (!data || data.length === 0) return null;
		return data[0];
	};

	const recoverMutation = createMutation(() => ({
		mutationFn: async (projectPath: string) => {
			const result = await commands.recoverRecording(projectPath);
			await commands.showWindow({ Editor: { project_path: result } });
			await incompleteRecordings.refetch();
			return result;
		},
	}));

	const discardMutation = createMutation(() => ({
		mutationFn: async (projectPath: string) => {
			await commands.discardIncompleteRecording(projectPath);
			await incompleteRecordings.refetch();
		},
	}));

	const isProcessing = () =>
		recoverMutation.isPending || discardMutation.isPending;

	const recording = () => mostRecent();
	const duration = () => {
		const r = recording();
		if (!r || r.estimatedDurationSecs <= 0) return null;
		return formatDuration(r.estimatedDurationSecs);
	};

	return (
		<Show when={!dismissed() && recording()}>
			{(rec) => (
				<div class="absolute bottom-3 left-3 right-3 bg-red-2 border border-red-6 rounded-lg p-2.5 shadow-lg animate-in slide-in-from-bottom-2 fade-in duration-200">
					<div class="flex items-center gap-2">
						<div class="flex-1 min-w-0">
							<p class="text-red-11 text-[10px] font-medium">
								Incomplete Recording
							</p>
							<p class="text-gray-12 text-xs font-medium truncate">
								{rec().prettyName}
							</p>
							<p class="text-gray-11 text-[10px]">
								{rec().segmentCount} segment
								{rec().segmentCount !== 1 ? "s" : ""}
								{duration() && ` · ~${duration()}`}
							</p>
							<Show when={recoverMutation.error}>
								{(error) => {
									const errorMessage = () => {
										const e = error();
										if (e instanceof Error) return e.message;
										if (typeof e === "string") return e;
										return "Recovery failed. The recording may be corrupted.";
									};
									return (
										<p class="text-red-11 text-[10px] mt-1">{errorMessage()}</p>
									);
								}}
							</Show>
						</div>
						<div class="flex gap-1.5 shrink-0">
							<Button
								onClick={() => recoverMutation.mutate(rec().projectPath)}
								disabled={isProcessing()}
								variant="primary"
								size="xs"
							>
								{recoverMutation.isPending ? "..." : "Recover"}
							</Button>
							<Button
								onClick={() => discardMutation.mutate(rec().projectPath)}
								disabled={isProcessing()}
								variant="gray"
								size="xs"
							>
								Discard
							</Button>
						</div>
					</div>
				</div>
			)}
		</Show>
	);
}
