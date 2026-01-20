"use client";

import { Button } from "@cap/ui";
import { ArrowLeft, Download, Redo2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { useEditorContext } from "./context";

interface HeaderProps {
	videoId: string;
}

export function Header({ videoId }: HeaderProps) {
	const { video, history, project } = useEditorContext();
	const [isExporting, setIsExporting] = useState(false);

	const handleExport = useCallback(async () => {
		setIsExporting(true);
		try {
			const response = await fetch(`/api/editor/${videoId}/export`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ config: project }),
			});

			if (!response.ok) {
				throw new Error("Export failed");
			}
		} finally {
			setIsExporting(false);
		}
	}, [videoId, project]);

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

				<h1 className="text-sm font-medium text-gray-12 truncate max-w-[120px] sm:max-w-[200px] md:max-w-[300px]">
					{video.name}
				</h1>
			</div>

			<div className="flex items-center gap-1 sm:gap-2">
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
					onClick={handleExport}
					disabled={isExporting}
					spinner={isExporting}
				>
					<Download className="size-4 sm:mr-1.5" />
					<span className="hidden sm:inline">Export</span>
				</Button>
			</div>
		</header>
	);
}
