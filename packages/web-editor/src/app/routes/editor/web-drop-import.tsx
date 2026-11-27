import { createSignal, onCleanup, onMount, Show } from "solid-js";
import toast from "solid-toast";
import { createWebMediaImport } from "./web-media-import";

const AUDIO_FILE = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;
const VIDEO_FILE = /\.(mp4|webm)$/i;

const hasFiles = (event: DragEvent) =>
	Array.from(event.dataTransfer?.types ?? []).includes("Files");

const kindOf = (file: File) =>
	file.type.startsWith("audio/") || AUDIO_FILE.test(file.name)
		? "audio"
		: file.type === "video/mp4" ||
				file.type === "video/webm" ||
				VIDEO_FILE.test(file.name)
			? "clip"
			: null;

export function WebDropImport() {
	const { busy, addAudio, addClip } = createWebMediaImport();
	const [dragging, setDragging] = createSignal(false);
	let depth = 0;

	const importFile = (file: File) => {
		const kind = kindOf(file);
		if (!kind) {
			toast.error("Drop an MP4 or WebM video, or an audio file");
			return;
		}
		if (kind === "audio") void addAudio(file, file.name);
		else void addClip(file, file.name);
	};

	onMount(() => {
		const enter = (event: DragEvent) => {
			if (!hasFiles(event) || busy()) return;
			event.preventDefault();
			depth += 1;
			setDragging(true);
		};
		const over = (event: DragEvent) => {
			if (!hasFiles(event) || busy()) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		};
		const leave = () => {
			depth = Math.max(0, depth - 1);
			if (depth === 0) setDragging(false);
		};
		const drop = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			depth = 0;
			setDragging(false);
			const file = event.dataTransfer?.files[0];
			if (file && !busy()) importFile(file);
		};
		window.addEventListener("dragenter", enter);
		window.addEventListener("dragover", over);
		window.addEventListener("dragleave", leave);
		window.addEventListener("drop", drop);
		onCleanup(() => {
			window.removeEventListener("dragenter", enter);
			window.removeEventListener("dragover", over);
			window.removeEventListener("dragleave", leave);
			window.removeEventListener("drop", drop);
		});
	});

	return (
		<Show when={dragging()}>
			<div class="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-black/25 backdrop-blur-[2px]">
				<div class="absolute inset-3 rounded-2xl border-2 border-dashed border-ed-accent opacity-70" />
				<div class="flex max-w-sm flex-col items-center gap-1.5 rounded-2xl bg-ed-card px-7 py-5 text-center shadow-ed-card">
					<span class="text-[15px] font-medium text-ed-text-1">
						Drop to add to your project
					</span>
					<span class="text-[13px] leading-snug text-ed-text-2">
						Videos go on the end of your timeline. Audio gets a track of its
						own.
					</span>
				</div>
			</div>
		</Show>
	);
}
