"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { ArrowLeft, Redo2, Save, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { editTitle } from "@/actions/videos/edit-title";
import type { ProjectConfiguration } from "../types/project-config";
import { resolveBackgroundAssetPath } from "../utils/backgrounds";
import { useEditorContext } from "./context";

interface HeaderProps {
	videoId: string;
}

function normalizeProjectForSave(
	project: ProjectConfiguration,
): ProjectConfiguration {
	const source = project.background.source;
	if (
		(source.type !== "wallpaper" && source.type !== "image") ||
		!source.path
	) {
		return project;
	}

	const normalizedPath = resolveBackgroundAssetPath(source.path);
	if (
		normalizedPath.startsWith("http://") ||
		normalizedPath.startsWith("https://") ||
		normalizedPath.startsWith("data:")
	) {
		return project;
	}

	const absolutePath =
		typeof window === "undefined"
			? normalizedPath
			: new URL(normalizedPath, window.location.origin).toString();

	return {
		...project,
		background: {
			...project.background,
			source: {
				...source,
				path: absolutePath,
			},
		},
	};
}

export function Header({ videoId }: HeaderProps) {
	const { video, history, project } = useEditorContext();
	const { refresh } = useRouter();
	const [isSavingRender, setIsSavingRender] = useState(false);
	const [saveStatus, setSaveStatus] = useState<
		"IDLE" | "QUEUED" | "PROCESSING" | "COMPLETE" | "ERROR"
	>("IDLE");
	const [saveError, setSaveError] = useState<string | null>(null);
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [title, setTitle] = useState(video.name);
	const [isSavingTitle, setIsSavingTitle] = useState(false);
	const [editingTitleWidth, setEditingTitleWidth] = useState<number | null>(
		null,
	);
	const titleInputRef = useRef<HTMLInputElement | null>(null);

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

	const fetchSaveStatus = useCallback(async () => {
		try {
			const response = await fetch(`/api/editor/${videoId}/save`, {
				method: "GET",
				cache: "no-store",
			});

			if (!response.ok) {
				return;
			}

			const data = (await response.json()) as {
				status?: "IDLE" | "QUEUED" | "PROCESSING" | "COMPLETE" | "ERROR";
				renderState?: { error?: string | null };
			};
			if (data.status) {
				setSaveStatus(data.status);
			}
			setSaveError(data.renderState?.error ?? null);
		} catch {}
	}, [videoId]);

	useEffect(() => {
		fetchSaveStatus();
		const interval = window.setInterval(fetchSaveStatus, 3000);
		return () => window.clearInterval(interval);
	}, [fetchSaveStatus]);

	const handleSave = useCallback(
		async (force = false) => {
			setIsSavingRender(true);
			setSaveError(null);
			const configToSave = normalizeProjectForSave(project);
			try {
				const response = await fetch(`/api/editor/${videoId}/save`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ config: configToSave, force }),
				});

				if (!response.ok) {
					const data = (await response.json().catch(() => ({}))) as {
						error?: string;
					};
					setSaveStatus("ERROR");
					setSaveError(data.error || "Failed to save changes");
					return;
				}

				const data = (await response.json()) as {
					status?: "IDLE" | "QUEUED" | "PROCESSING" | "COMPLETE" | "ERROR";
					renderState?: { error?: string | null };
				};
				setSaveStatus(data.status ?? "QUEUED");
				setSaveError(data.renderState?.error ?? null);
			} catch (error) {
				setSaveStatus("ERROR");
				setSaveError(error instanceof Error ? error.message : "Failed to save");
			} finally {
				setIsSavingRender(false);
			}
		},
		[videoId, project],
	);

	const isRenderBusy = saveStatus === "QUEUED" || saveStatus === "PROCESSING";
	const isSaveProcessing = isSavingRender || isRenderBusy;

	const handleSaveClick = useCallback(() => {
		if (isRenderBusy) {
			const shouldRetry = window.confirm(
				"A previous save is still marked as processing. Start a new save anyway?",
			);
			if (!shouldRetry) {
				return;
			}
			void handleSave(true);
			return;
		}

		void handleSave();
	}, [handleSave, isRenderBusy]);

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
			refresh();
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
	}, [title, video.name, videoId, refresh]);

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
				{isSaveProcessing && (
					<span className="hidden lg:inline text-xs text-gray-10">
						Processing saved changes...
					</span>
				)}
				{saveStatus === "ERROR" && saveError && (
					<span className="hidden lg:inline text-xs text-red-10 max-w-56 truncate">
						{saveError}
					</span>
				)}
				<div className="flex items-center gap-1 mr-1 sm:mr-2">
					<button
						type="button"
						onClick={history.undo}
						disabled={!history.canUndo}
						className="flex items-center justify-center size-8 rounded-lg text-gray-11 hover:text-gray-12 hover:bg-gray-3 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
						title="Undo (Cmd+Z)"
					>
						<Undo2 className="size-4" />
					</button>
					<button
						type="button"
						onClick={history.redo}
						disabled={!history.canRedo}
						className="flex items-center justify-center size-8 rounded-lg text-gray-11 hover:text-gray-12 hover:bg-gray-3 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
						title="Redo (Cmd+Shift+Z)"
					>
						<Redo2 className="size-4" />
					</button>
				</div>

				<Button
					variant="primary"
					size="sm"
					onClick={handleSaveClick}
					disabled={isSavingRender}
					spinner={isSavingRender}
				>
					<Save className="size-4 sm:mr-1.5" />
					<span className="hidden sm:inline">
						{isSavingRender
							? "Saving..."
							: isRenderBusy
								? "Retry Save"
								: "Save"}
					</span>
				</Button>
			</div>
		</header>
	);
}
