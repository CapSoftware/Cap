"use client";

import type { Video } from "@cap/web-domain";
import clsx from "clsx";
import {
	AudioLinesIcon,
	FilmIcon,
	LoaderCircleIcon,
	UploadIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {
	type DragEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	EditorShellBar,
	type EditorTab,
} from "@/components/editor-shell/EditorShellBar";
import {
	type ImageLoadingStatus,
	VideoThumbnail,
} from "@/components/VideoThumbnail";
import { useDashboardContext } from "../Contexts";
import { Squiggle } from "../caps/components/web-recorder-dialog/recorder-parts";
import { WebRecorderDialog } from "../caps/components/web-recorder-dialog/web-recorder-dialog";
import type { UploadStatus } from "../caps/UploadingContext";
import { useUploadingContext } from "../caps/UploadingContext";
import { importMediaFile, isSupportedEditorFile } from "../import/import-media";
import {
	isSupportedAudioFile,
	isSupportedVideoFile,
} from "../import/media-file-types";

export type RecentRecording = {
	id: string;
	name: string;
	createdAt: string;
	duration: number | null;
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
});

const hasFiles = (event: DragEvent) =>
	Array.from(event.dataTransfer?.types ?? []).includes("Files");

export function EditorApp({ recordings }: { recordings: RecentRecording[] }) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const tab: EditorTab =
		searchParams.get("tab") === "record" ? "record" : "editor";
	const setTab = useCallback(
		(next: EditorTab) => {
			router.replace(
				next === "record"
					? "/dashboard/editor?tab=record"
					: "/dashboard/editor",
				{ scroll: false },
			);
		},
		[router],
	);

	return (
		<div className="cap-rec fixed inset-0 z-[300] flex flex-col bg-[var(--rec-window)] text-[var(--rec-text-1)]">
			{/* A full-screen app: the support launcher would sit over its controls. */}
			<style>{".cap-messenger-launcher{display:none!important}"}</style>
			<EditorShellBar tab={tab} onTabChange={setTab} />
			<div className="relative flex min-h-0 flex-1 flex-col">
				{tab === "record" ? (
					<WebRecorderDialog embedded />
				) : (
					<EditorHome
						recordings={recordings}
						onRecord={() => setTab("record")}
					/>
				)}
			</div>
		</div>
	);
}

type ImportState = {
	fileName: string;
	status: UploadStatus | undefined;
	/** 0-1 while an audio file is being turned into a video. */
	converting?: number;
};

function RecordingThumbnail({ recording }: { recording: RecentRecording }) {
	const [imageStatus, setImageStatus] = useState<ImageLoadingStatus>("loading");
	return (
		<VideoThumbnail
			videoId={recording.id as Video.VideoId}
			alt={recording.name}
			videoDuration={recording.duration ?? undefined}
			containerClass="absolute inset-0"
			imageStatus={imageStatus}
			setImageStatus={setImageStatus}
		/>
	);
}

function EditorHome({
	recordings,
	onRecord,
}: {
	recordings: RecentRecording[];
	onRecord: () => void;
}) {
	const router = useRouter();
	const { activeOrganization } = useDashboardContext();
	const { setUploadStatus } = useUploadingContext();
	const [dragging, setDragging] = useState(false);
	const [importing, setImporting] = useState<ImportState | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const dragDepth = useRef(0);

	const start = useCallback(
		async (file: File) => {
			const orgId = activeOrganization?.organization.id;
			if (!orgId) {
				toast.error("Choose an organization before starting a project.");
				return;
			}
			if (!isSupportedEditorFile(file)) {
				toast.error("Drop a video or audio file to start a project.");
				return;
			}
			let videoId: string | null = null;
			let upload = file;
			if (isSupportedAudioFile(file) && !isSupportedVideoFile(file)) {
				setImporting({ fileName: file.name, status: undefined, converting: 0 });
				try {
					const { convertAudioToVideo } = await import("@/lib/audio-to-video");
					upload = await convertAudioToVideo(file, (converting) =>
						setImporting((current) =>
							current ? { ...current, converting } : current,
						),
					);
				} catch (error) {
					console.error("Audio conversion failed", error);
					toast.error(
						error instanceof Error
							? `Couldn't use that audio file: ${error.message}`
							: "Couldn't use that audio file",
					);
					setImporting(null);
					return;
				}
			}
			setImporting({ fileName: file.name, status: { status: "parsing" } });
			const ok = await importMediaFile({
				file: upload,
				orgId,
				setUploadStatus: (status) => {
					setUploadStatus(status);
					setImporting((current) =>
						current ? { ...current, status } : current,
					);
				},
				onVideoCreated: (id) => {
					videoId = id;
				},
				quiet: true,
			});
			if (ok && videoId) {
				router.push(`/s/${videoId}/edit?from=import`);
				return;
			}
			setImporting(null);
		},
		[activeOrganization, router, setUploadStatus],
	);

	useEffect(() => {
		const reset = () => {
			dragDepth.current = 0;
			setDragging(false);
		};
		window.addEventListener("dragend", reset);
		return () => window.removeEventListener("dragend", reset);
	}, []);

	const status = importing?.status;
	const progress =
		importing?.converting !== undefined
			? importing.converting
			: status?.status === "uploadingVideo"
				? status.progress / 100
				: null;

	return (
		<main
			className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 sm:px-3 sm:pb-3"
			onDragEnter={(event) => {
				if (!hasFiles(event) || importing) return;
				event.preventDefault();
				dragDepth.current += 1;
				setDragging(true);
			}}
			onDragOver={(event) => {
				if (!hasFiles(event) || importing) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={() => {
				dragDepth.current = Math.max(0, dragDepth.current - 1);
				if (dragDepth.current === 0) setDragging(false);
			}}
			onDrop={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				dragDepth.current = 0;
				setDragging(false);
				const file = event.dataTransfer.files[0];
				if (file) void start(file);
			}}
		>
			<section
				className={clsx(
					"rec-card relative flex min-h-[20rem] flex-1 flex-col items-center justify-center overflow-hidden px-6 py-10 text-center transition-shadow",
					dragging &&
						"shadow-[0_0_0_2px_var(--rec-accent),var(--rec-card-shadow)]",
				)}
			>
				{importing ? (
					<div className="rec-fade flex flex-col items-center">
						<LoaderCircleIcon
							className="size-6 animate-spin text-[var(--rec-accent)]"
							aria-hidden
						/>
						<h1 className="mt-5 text-[20px] font-medium tracking-[-0.01em]">
							Starting your project
						</h1>
						<p className="mt-1.5 max-w-sm truncate text-[14px] text-[var(--rec-text-2)]">
							{importing.fileName}
						</p>
						<div className="mt-7">
							<Squiggle progress={progress} />
						</div>
						<p className="mt-3 text-[12px] text-[var(--rec-text-3)]">
							{importing.converting !== undefined
								? "Turning your audio into a project"
								: status?.status === "uploadingVideo"
									? "Uploading. The editor opens when it's ready."
									: status?.status === "serverProcessing"
										? "Preparing your tracks"
										: "Reading your file"}
						</p>
					</div>
				) : (
					<div className="flex max-w-md flex-col items-center">
						<div className="flex items-center gap-2" aria-hidden>
							<span
								className="rec-track flex size-11 items-center justify-center rounded-xl"
								data-kind="screen"
							>
								<span className="rec-track-tile flex size-11 items-center justify-center rounded-xl">
									<FilmIcon className="size-5" />
								</span>
							</span>
							<span
								className="rec-track flex size-11 items-center justify-center rounded-xl"
								data-kind="mic"
							>
								<span className="rec-track-tile flex size-11 items-center justify-center rounded-xl">
									<AudioLinesIcon className="size-5" />
								</span>
							</span>
						</div>
						<h1 className="mt-5 text-[22px] font-medium tracking-[-0.01em]">
							{dragging ? "Drop to start a new project" : "Start a new project"}
						</h1>
						<p className="mt-2 text-balance text-[14px] leading-relaxed text-[var(--rec-text-2)]">
							Drop a video or audio file anywhere here, or record something new.
							It opens straight in the editor.
						</p>
						<div className="mt-6 flex items-center gap-2">
							<button
								type="button"
								className="rec-btn is-accent !h-9 !px-4"
								onClick={() => inputRef.current?.click()}
							>
								<UploadIcon className="size-4" aria-hidden />
								Choose a file
							</button>
							<button
								type="button"
								className="rec-btn !h-9 !px-4"
								onClick={onRecord}
							>
								<span className="size-2 rounded-full bg-[var(--rec-red)]" />
								Record
							</button>
						</div>
						<input
							ref={inputRef}
							type="file"
							accept="video/*,audio/*,.mov,.mp4,.m4v,.webm,.mkv,.avi,.mp3,.wav,.m4a,.aac,.ogg,.flac"
							className="hidden"
							onChange={(event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (file) void start(file);
							}}
						/>
					</div>
				)}
				{dragging && !importing && (
					<span className="pointer-events-none absolute inset-3 rounded-[10px] border-2 border-dashed border-[var(--rec-accent)] opacity-60" />
				)}
			</section>
			<section className="rec-card shrink-0 p-3">
				<div className="flex items-baseline justify-between px-1 pb-3">
					<h2 className="text-[13px] font-medium">Recent recordings</h2>
					<span className="text-[12px] text-[var(--rec-text-3)]">
						Open one to keep editing
					</span>
				</div>
				{recordings.length === 0 ? (
					<p className="px-1 pb-2 text-[13px] text-[var(--rec-text-2)]">
						Your recordings will show up here.
					</p>
				) : (
					<ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
						{recordings.map((recording) => (
							<li key={recording.id}>
								<button
									type="button"
									onClick={() => router.push(`/s/${recording.id}/edit`)}
									className="rec-focus group flex w-full flex-col gap-2 rounded-[10px] p-1.5 text-left transition-colors hover:bg-[var(--rec-ctl)]"
								>
									<span className="relative block aspect-video w-full overflow-hidden rounded-md bg-[var(--rec-card-2)] shadow-[inset_0_0_0_1px_var(--rec-line)]">
										<RecordingThumbnail recording={recording} />
									</span>
									<span className="flex min-w-0 flex-col px-0.5">
										<span className="truncate text-[13px] font-medium">
											{recording.name}
										</span>
										<span className="text-[12px] text-[var(--rec-text-3)]">
											{dateFormatter.format(new Date(recording.createdAt))}
										</span>
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	);
}
