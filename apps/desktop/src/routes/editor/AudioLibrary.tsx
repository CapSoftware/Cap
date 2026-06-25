import { open } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createResource,
	createRoot,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import toast from "solid-toast";

import { commands, type ImportedAudioTrack } from "~/utils/tauri";
import { AUDIO_IMPORT_EXTENSIONS } from "./audio";
import { useEditorContext } from "./context";
import { EditorButton } from "./ui";

const previewUrls = import.meta.glob<string>("../../assets/music/*.mp3", {
	eager: true,
	query: "?url",
	import: "default",
});

const previewUrlById = new Map<string, string>(
	Object.entries(previewUrls).map(([path, url]) => {
		const file = path.split("/").pop() ?? "";
		const id = file.replace(/\.mp3$/, "");
		return [id, url];
	}),
);

const makeLibraryResource = () =>
	createResource(() => commands.listAudioLibrary());

// Cached once for the app lifetime so reopening the picker (e.g. switching into
// "change track" mode) doesn't refetch and flash the loading skeleton.
let sharedLibrary: ReturnType<typeof makeLibraryResource> | undefined;

const useAudioLibrary = () => {
	if (!sharedLibrary)
		createRoot(() => {
			sharedLibrary = makeLibraryResource();
		});
	return sharedLibrary as ReturnType<typeof makeLibraryResource>;
};

const EQ_BARS = [
	{ delay: 0, duration: 0.9 },
	{ delay: 0.2, duration: 1.1 },
	{ delay: 0.35, duration: 0.8 },
	{ delay: 0.12, duration: 1.05 },
];

function EqualizerBars() {
	return (
		<div class="flex gap-[2px] items-end h-2.5">
			<For each={EQ_BARS}>
				{(bar) => (
					<span
						class="w-[2px] h-full rounded-full bg-gray-11"
						style={{
							"transform-origin": "bottom",
							animation: `cap-audio-eq ${bar.duration}s ease-in-out ${bar.delay}s infinite`,
						}}
					/>
				)}
			</For>
		</div>
	);
}

type AudioPickerMode =
	| { type: "add"; lane: number }
	| { type: "replace"; index: number };

export function AudioLibraryPanel(props: {
	mode: AudioPickerMode;
	onClose: () => void;
}) {
	const { projectActions } = useEditorContext();
	const [library] = useAudioLibrary();
	const [busyId, setBusyId] = createSignal<string | null>(null);
	const [uploading, setUploading] = createSignal(false);
	const [previewId, setPreviewId] = createSignal<string | null>(null);
	const [selectedCategory, setSelectedCategory] = createSignal<string | null>(
		null,
	);

	const isReplace = () => props.mode.type === "replace";

	type LibraryTrack = NonNullable<ReturnType<typeof library>>[number];

	const categories = createMemo(() => {
		const grouped = new Map<string, LibraryTrack[]>();
		for (const track of library() ?? []) {
			const list = grouped.get(track.category) ?? [];
			list.push(track);
			grouped.set(track.category, list);
		}
		return [...grouped.entries()];
	});

	createEffect(() => {
		if (selectedCategory() === null && categories().length > 0)
			setSelectedCategory(categories()[0][0]);
	});

	const activeTracks = createMemo(() => {
		const cat = selectedCategory();
		const list = categories();
		return (list.find(([c]) => c === cat) ?? list[0])?.[1] ?? [];
	});

	let previewAudio: HTMLAudioElement | null = null;

	const stopPreview = () => {
		if (previewAudio) {
			previewAudio.pause();
			previewAudio = null;
		}
		setPreviewId(null);
	};

	const togglePreview = (id: string) => {
		if (previewId() === id) {
			stopPreview();
			return;
		}
		stopPreview();
		const url = previewUrlById.get(id);
		if (!url) return;
		const audio = new Audio(url);
		audio.volume = 0.7;
		audio.addEventListener("ended", () => {
			if (previewId() === id) stopPreview();
		});
		audio.play().catch(() => {});
		previewAudio = audio;
		setPreviewId(id);
	};

	onCleanup(stopPreview);

	const commit = (imported: ImportedAudioTrack) => {
		stopPreview();
		if (props.mode.type === "replace")
			projectActions.replaceAudioSegment(props.mode.index, imported);
		else projectActions.addAudioSegment(props.mode.lane, imported);
		props.onClose();
	};

	const addLibraryTrack = async (id: string) => {
		if (busyId()) return;
		setBusyId(id);
		try {
			commit(await commands.addAudioLibraryTrack(id));
		} catch (error) {
			console.error("Failed to add audio track", error);
			toast.error("Failed to add audio track");
		} finally {
			setBusyId(null);
		}
	};

	const uploadTrack = async () => {
		if (uploading()) return;
		setUploading(true);
		try {
			const selected = await open({
				multiple: false,
				filters: [{ name: "Audio", extensions: [...AUDIO_IMPORT_EXTENSIONS] }],
			});
			if (typeof selected !== "string") return;
			commit(await commands.importAudioTrackFile(selected));
		} catch (error) {
			console.error("Failed to import audio file", error);
			toast.error("Failed to import audio file");
		} finally {
			setUploading(false);
		}
	};

	return (
		<div class="flex flex-col gap-4">
			<div class="flex flex-row gap-2 items-center">
				<EditorButton
					onClick={() => props.onClose()}
					leftIcon={<IconLucideCheck />}
				>
					Done
				</EditorButton>
				<span class="text-sm text-gray-10">
					{isReplace() ? "Change audio" : "Add audio"}
				</span>
			</div>

			<p class="text-xs text-gray-10">
				{isReplace()
					? "Pick a different track for this segment"
					: "Add audio, music or other sounds to your video"}
			</p>

			<Show when={categories().length > 0}>
				<div class="flex flex-wrap gap-2 items-center">
					<For each={categories()}>
						{([category]) => (
							<button
								type="button"
								onClick={() => setSelectedCategory(category)}
								class={cx(
									"px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors duration-150",
									selectedCategory() === category
										? "bg-gray-3 border-gray-3 text-gray-12"
										: "bg-transparent border-transparent text-gray-11 hover:border-gray-6",
								)}
							>
								{category}
							</button>
						)}
					</For>
					<span class="text-[11px] text-gray-9">
						More categories coming soon
					</span>
				</div>
			</Show>

			<div class="w-full border-t border-dashed border-gray-4" />

			<Show
				when={!library.loading}
				fallback={
					<div class="grid grid-cols-5 gap-2">
						<For each={Array.from({ length: 9 })}>
							{() => (
								<div class="flex flex-col gap-1">
									<div class="rounded-lg aspect-square bg-gray-3 animate-pulse" />
									<div class="w-2/3 h-2 rounded bg-gray-3 animate-pulse" />
								</div>
							)}
						</For>
					</div>
				}
			>
				<div class="grid grid-cols-5 gap-2">
					<For each={activeTracks()}>
						{(track) => {
							const isBusy = () => busyId() === track.id;
							const isPreviewing = () => previewId() === track.id;
							return (
								<div class="flex flex-col gap-1 min-w-0">
									<div
										class={cx(
											"group/tile overflow-hidden relative rounded-lg aspect-square transition-all duration-200 bg-gray-3 ring-offset-1 ring-offset-gray-200",
											isPreviewing()
												? "ring-2 ring-gray-500 ring-offset-2"
												: "hover:ring-1 hover:ring-gray-400",
											isBusy() && "opacity-70",
										)}
									>
										<button
											type="button"
											class="absolute inset-0 w-full h-full"
											aria-label={
												isPreviewing() ? "Pause preview" : "Play preview"
											}
											onClick={() => togglePreview(track.id)}
										>
											<Show when={!isPreviewing()}>
												<div class="flex absolute inset-0 justify-center items-center opacity-40 transition-opacity group-hover/tile:opacity-0">
													<IconLucideMusic2 class="size-3.5 text-gray-11" />
												</div>
											</Show>
											<div
												class={cx(
													"flex absolute inset-0 justify-center items-center transition-opacity",
													isPreviewing()
														? "opacity-100"
														: "opacity-0 group-hover/tile:opacity-100",
												)}
											>
												<span class="flex justify-center items-center rounded-full border shadow-sm backdrop-blur-sm transition-all duration-200 size-6 bg-black/40 border-white/25 text-white">
													<Show
														when={isPreviewing()}
														fallback={
															<IconLucidePlay class="translate-x-px size-3" />
														}
													>
														<IconLucidePause class="size-3" />
													</Show>
												</span>
											</div>
										</button>

										<Show when={isPreviewing()}>
											<div class="absolute top-1 left-1 pointer-events-none">
												<EqualizerBars />
											</div>
										</Show>

										<button
											type="button"
											aria-label={isReplace() ? "Use track" : "Add to timeline"}
											class={cx(
												"flex absolute top-1 right-1 justify-center items-center rounded-full border backdrop-blur-sm transition-all size-5",
												"opacity-0 group-hover/tile:opacity-100",
												isPreviewing() && "opacity-100",
												isBusy()
													? "bg-gray-12 border-gray-12 text-gray-1"
													: "bg-black/45 border-white/20 text-white hover:bg-gray-12 hover:border-gray-12 hover:text-gray-1",
											)}
											disabled={isBusy()}
											onClick={(e) => {
												e.stopPropagation();
												addLibraryTrack(track.id);
											}}
										>
											<Show
												when={!isBusy()}
												fallback={
													<div class="rounded-full border-2 animate-spin size-2.5 border-white/40 border-t-white" />
												}
											>
												<Show
													when={isReplace()}
													fallback={<IconLucidePlus class="size-2.5" />}
												>
													<IconLucideRefreshCw class="size-2.5" />
												</Show>
											</Show>
										</button>
									</div>
									<span class="px-0.5 text-[10px] truncate text-gray-11">
										{track.name}
									</span>
								</div>
							);
						}}
					</For>
				</div>
			</Show>

			<button
				type="button"
				disabled={uploading()}
				onClick={uploadTrack}
				class="flex flex-col gap-1.5 justify-center items-center p-4 w-full text-center rounded-xl border border-dashed transition-colors bg-gray-2 border-gray-5 hover:bg-gray-3 hover:border-gray-7 disabled:opacity-60"
			>
				<span class="flex justify-center items-center mb-0.5 rounded-full size-9 bg-gray-3 text-gray-11">
					<Show
						when={!uploading()}
						fallback={
							<div class="rounded-full border-2 animate-spin size-4 border-gray-6 border-t-gray-11" />
						}
					>
						<IconLucideUpload class="size-4" />
					</Show>
				</span>
				<span class="text-[13px] font-medium text-gray-12">
					{uploading() ? "Importing…" : "Upload your own"}
				</span>
				<span class="text-[11px] text-gray-9">
					MP3, WAV, M4A, OGG, FLAC, AAC
				</span>
			</button>
		</div>
	);
}
