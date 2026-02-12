"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { ArrowLeft, Check, Link2, Redo2, Undo2, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { editTitle } from "@/actions/videos/edit-title";
import type { ProjectConfiguration } from "../types/project-config";
import { useEditorContext } from "./context";

interface HeaderProps {
	videoId: string;
}

export function Header({ videoId }: HeaderProps) {
	const {
		video,
		history,
		project,
		projectUpdatedAt,
		syncProject,
		saveRender,
	} = useEditorContext();
	const router = useRouter();
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [title, setTitle] = useState(video.name);
	const [isSavingTitle, setIsSavingTitle] = useState(false);
	const [isNavigatingToExport, setIsNavigatingToExport] = useState(false);
	const [editingTitleWidth, setEditingTitleWidth] = useState<number | null>(
		null,
	);
	const titleInputRef = useRef<HTMLInputElement | null>(null);

	const { saveState, isSaving, isSubmitting, canRetry, save, hasSavedRender } =
		saveRender;

	useEffect(() => {
		if (!isEditingTitle) {
			setTitle(video.name);
		}
	}, [video.name, isEditingTitle]);

	useEffect(() => {
		if (isEditingTitle) {
			titleInputRef.current?.focus();
			titleInputRef.current?.select();
		}
	}, [isEditingTitle]);

	useEffect(() => {
		if (!isEditingTitle) {
			setEditingTitleWidth(null);
		}
	}, [isEditingTitle]);

	const handleSaveClick = useCallback(() => {
		if (canRetry) {
			save(project, true);
			return;
		}
		save(project);
	}, [save, project, canRetry]);

	const saveTitle = useCallback(async () => {
		setIsEditingTitle(false);
		const nextTitle = title.trim();

		if (nextTitle === "" || nextTitle === video.name) {
			setTitle(video.name);
			return;
		}

		setIsSavingTitle(true);
		try {
			await editTitle(videoId as Video.VideoId, nextTitle);
			setTitle(nextTitle);
			router.refresh();
		} catch (error) {
			setTitle(video.name);
			if (error instanceof Error) {
				toast.error(error.message);
			} else {
				toast.error("Failed to update title - please try again.");
			}
		} finally {
			setIsSavingTitle(false);
		}
	}, [title, video.name, videoId, router]);

	const isBusy = isSubmitting || (isSaving && !canRetry);
	const showComplete = saveState.status === "COMPLETE";

	let buttonLabel = hasSavedRender ? "Re-save" : "Create shareable link";
	if (isSubmitting) {
		buttonLabel = "Saving...";
	} else if (isSaving && !canRetry) {
		buttonLabel = "Saving...";
	} else if (showComplete) {
		buttonLabel = "Saved!";
	} else if (canRetry) {
		buttonLabel = "Retry Save";
	}

	const handleExportClick = useCallback(async () => {
		if (isNavigatingToExport) return;
		setIsNavigatingToExport(true);

		try {
			const response = await fetch(`/api/editor/${videoId}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					config: project,
					expectedUpdatedAt: projectUpdatedAt,
				}),
			});
			const data = (await response.json().catch(() => null)) as
				| {
						code?: string;
						config?: ProjectConfiguration;
						updatedAt?: string;
				  }
				| null;

			if (
				response.status === 409 &&
				data?.code === "CONFIG_CONFLICT" &&
				data.config &&
				typeof data.updatedAt === "string"
			) {
				syncProject(data.config, data.updatedAt);
				toast.error("This tab synced to newer changes from another tab.");
			}
		} finally {
			router.push(`/editor/${videoId}/export`);
		}
	}, [
		isNavigatingToExport,
		project,
		projectUpdatedAt,
		router,
		syncProject,
		videoId,
	]);

	return (
		<header className="flex items-center justify-between h-12 sm:h-14 px-2 sm:px-4 border-b border-gray-4 bg-gray-2 shrink-0">
			<div className="flex items-center gap-2 sm:gap-4 min-w-0">
				<Link
					href={`/s/${videoId}`}
					className="flex items-center gap-2 text-gray-11 hover:text-gray-12 transition-colors"
				>
					<ArrowLeft className="size-4" />
					<span className="text-sm hidden sm:inline">Back</span>
				</Link>

				<div className="h-5 w-px bg-gray-4 hidden sm:block" />

				<div className="min-w-0 max-w-[120px] sm:max-w-[200px] md:max-w-[300px]">
					{isEditingTitle ? (
						<input
							ref={titleInputRef}
							type="text"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							onBlur={() => {
								void saveTitle();
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									event.currentTarget.blur();
								}
								if (event.key === "Escape") {
									event.preventDefault();
									setTitle(video.name);
									setIsEditingTitle(false);
								}
							}}
							disabled={isSavingTitle}
							style={
								editingTitleWidth == null
									? undefined
									: { width: `${editingTitleWidth}px` }
							}
							className="appearance-none bg-transparent border-0 m-0 p-0 text-sm font-medium leading-5 text-gray-12 focus:outline-none min-w-0"
						/>
					) : (
						<h1 className="truncate text-sm font-medium leading-5 text-gray-12">
							<button
								type="button"
								onClick={(event) => {
									setEditingTitleWidth(
										event.currentTarget.getBoundingClientRect().width,
									);
									setIsEditingTitle(true);
								}}
								className="w-full truncate bg-transparent border-0 m-0 p-0 text-left text-sm font-medium leading-5 text-gray-12 cursor-text focus:outline-none"
							>
								{title}
							</button>
						</h1>
					)}
				</div>
			</div>

			<div className="flex items-center gap-1 sm:gap-2">
				{saveState.status === "ERROR" && saveState.error && (
					<span className="hidden lg:inline text-xs text-red-10 max-w-56 truncate">
						{saveState.error}
					</span>
				)}
				<div className="flex items-center gap-1 mr-1 sm:mr-2">
					<button
						type="button"
						onClick={history.undo}
						disabled={!history.canUndo || isSaving}
						className="flex items-center justify-center size-8 rounded-lg text-gray-11 hover:text-gray-12 hover:bg-gray-3 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
						title="Undo (Cmd+Z)"
					>
						<Undo2 className="size-4" />
					</button>
					<button
						type="button"
						onClick={history.redo}
						disabled={!history.canRedo || isSaving}
						className="flex items-center justify-center size-8 rounded-lg text-gray-11 hover:text-gray-12 hover:bg-gray-3 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
						title="Redo (Cmd+Shift+Z)"
					>
						<Redo2 className="size-4" />
					</button>
				</div>

				<Button
					variant="gray"
					size="sm"
					onClick={handleExportClick}
					disabled={isBusy || isNavigatingToExport}
					spinner={isNavigatingToExport}
				>
					<Upload className="size-4 sm:mr-1.5" />
					<span className="hidden sm:inline">Export</span>
				</Button>

				<Button
					variant="primary"
					size="sm"
					onClick={handleSaveClick}
					disabled={isBusy || showComplete || isNavigatingToExport}
					spinner={isBusy}
				>
					{showComplete ? (
						<Check className="size-4 sm:mr-1.5" />
					) : (
						<Link2 className="size-4 sm:mr-1.5" />
					)}
					<span className="hidden sm:inline">{buttonLabel}</span>
				</Button>
			</div>
		</header>
	);
}
