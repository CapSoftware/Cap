import { Button } from "@cap/ui-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSignal, Match, onCleanup, onMount, Switch } from "solid-js";
import {
	events,
	type VideoImportProgress as VideoImportProgressEvent,
} from "~/utils/tauri";
import IconLucideAlertCircle from "~icons/lucide/alert-circle";

const funMessages = [
	"Adjusting the Cap just right...",
	"Putting on our thinking Cap...",
	"Cap-sizing the pixels...",
	"Wearing our processing Cap...",
	"Cap-tivating import in progress...",
	"Flipping our Cap backwards...",
	"Cap-puccino break? Almost done...",
	"Cap-able of great things...",
];

export type ImportProgressProps = {
	projectPath: string;
	onComplete: () => void;
	onError: (error: string) => void;
};

export function ImportProgress(props: ImportProgressProps) {
	const [progress, setProgress] = createSignal<VideoImportProgressEvent | null>(
		null,
	);
	const [failed, setFailed] = createSignal<string | null>(null);
	const [messageIndex, setMessageIndex] = createSignal(
		Math.floor(Math.random() * funMessages.length),
	);

	let messageInterval: ReturnType<typeof setInterval> | undefined;
	let unlisten: (() => void) | undefined;

	onCleanup(() => {
		if (messageInterval) clearInterval(messageInterval);
		unlisten?.();
	});

	onMount(async () => {
		messageInterval = setInterval(() => {
			setMessageIndex((prev) => (prev + 1) % funMessages.length);
		}, 4000);

		unlisten = await events.videoImportProgress.listen((event) => {
			if (event.payload.project_path === props.projectPath) {
				setProgress(event.payload);
				if (event.payload.stage === "Complete") {
					props.onComplete();
				} else if (event.payload.stage === "Failed") {
					setFailed(event.payload.message);
					props.onError(event.payload.message);
				}
			}
		});
	});

	const progressPercent = () => Math.round((progress()?.progress ?? 0) * 100);

	const handleClose = async () => {
		await getCurrentWindow().close();
	};

	return (
		<div class="flex flex-col items-center justify-center h-full gap-6">
			<Switch>
				<Match when={failed()}>
					{(errorMessage) => (
						<div class="w-80 text-center">
							<div class="flex items-center justify-center mb-6">
								<div class="w-16 h-16 rounded-full bg-red-3 flex items-center justify-center">
									<IconLucideAlertCircle class="w-8 h-8 text-red-9" />
								</div>
							</div>

							<h2 class="text-lg font-medium text-gray-12 mb-2">
								Import Failed
							</h2>
							<p class="text-sm text-gray-11 mb-6">{errorMessage()}</p>

							<Button variant="gray" onClick={handleClose}>
								Close
							</Button>
						</div>
					)}
				</Match>
				<Match when={!failed()}>
					<div class="w-72 text-center">
						<div class="flex items-center justify-center mb-6">
							<div class="relative">
								<svg
									class="w-20 h-20 animate-spin-slow"
									viewBox="0 0 64 64"
									fill="none"
								>
									<circle
										cx="32"
										cy="32"
										r="28"
										stroke="currentColor"
										stroke-width="4"
										class="text-gray-3"
									/>
									<circle
										cx="32"
										cy="32"
										r="28"
										stroke="currentColor"
										stroke-width="4"
										stroke-dasharray={`${progressPercent() * 1.76} 176`}
										stroke-linecap="round"
										class="text-blue-9 transition-all duration-300"
										transform="rotate(-90 32 32)"
									/>
								</svg>
								<div class="absolute inset-0 flex items-center justify-center">
									<span class="text-lg font-semibold text-gray-12">
										{progressPercent()}%
									</span>
								</div>
							</div>
						</div>

						<h2 class="text-lg font-medium text-gray-12 mb-2">
							Importing Video
						</h2>
						<p class="text-sm text-gray-11 animate-pulse h-5 animate-pulse-slow">
							{funMessages[messageIndex()]}
						</p>
					</div>
				</Match>
			</Switch>
		</div>
	);
}
