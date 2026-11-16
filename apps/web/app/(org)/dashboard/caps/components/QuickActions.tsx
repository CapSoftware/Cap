"use client";

import clsx from "clsx";
import { useCapChromeExtension } from "hooks/useCapChromeExtension";
import { FolderPlus, Upload, Video } from "lucide-react";
import Image from "next/image";
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { CAP_CHROME_EXTENSION_URL } from "@/lib/chrome-extension";
import { UploadCapButton } from "./UploadCapButton";
import { WebRecorderDialog } from "./web-recorder-dialog/web-recorder-dialog";

const tileClass =
	"group flex flex-col gap-2.5 items-start p-3 w-full min-w-0 text-left rounded-xl border shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] duration-200 border-gray-3 bg-gray-1 hover:border-gray-5 hover:shadow-[0_4px_14px_-6px_rgba(0,0,0,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8 sm:flex-row sm:gap-3 sm:items-center";

type TileBodyProps = {
	icon: ReactNode;
	title: string;
	hint: string;
	accent?: boolean;
};

function TileBody({ icon, title, hint, accent }: TileBodyProps) {
	return (
		<>
			<span
				className={clsx(
					"flex justify-center items-center rounded-lg transition-colors size-9 shrink-0",
					accent
						? "text-white bg-blue-9 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
						: "bg-gray-3 text-gray-11 group-hover:text-gray-12",
				)}
			>
				{icon}
			</span>
			<span className="flex flex-col min-w-0 max-w-full">
				<span className="text-sm font-medium leading-5 text-gray-12">
					{title}
				</span>
				<span className="hidden text-[13px] leading-5 text-gray-10 sm:block">
					{hint}
				</span>
			</span>
		</>
	);
}

const QuickActionTile = forwardRef<
	HTMLButtonElement,
	TileBodyProps & ButtonHTMLAttributes<HTMLButtonElement>
>(({ icon, title, hint, accent, className, ...props }, ref) => (
	<button
		ref={ref}
		type="button"
		className={clsx(tileClass, className)}
		{...props}
	>
		<TileBody icon={icon} title={title} hint={hint} accent={accent} />
	</button>
));
QuickActionTile.displayName = "QuickActionTile";

const chromeIcon = (
	<Image
		src="/logos/browsers/google-chrome.svg"
		width={20}
		height={20}
		alt=""
		className="size-5 transition-transform duration-500 group-hover:rotate-[360deg]"
	/>
);

function ChromeTile() {
	const { isChromeBrowser, isInstalled, openRecorder } =
		useCapChromeExtension();

	if (isInstalled) {
		return (
			<QuickActionTile
				icon={chromeIcon}
				title="Record with Chrome"
				hint="Open the Cap extension"
				onClick={openRecorder}
			/>
		);
	}

	if (!isChromeBrowser) return null;

	return (
		<a
			href={CAP_CHROME_EXTENSION_URL}
			target="_blank"
			rel="noopener noreferrer"
			className={tileClass}
		>
			<TileBody
				icon={chromeIcon}
				title="Add to Chrome"
				hint="Record any tab in one click"
			/>
		</a>
	);
}

export function QuickActions({ onNewFolder }: { onNewFolder: () => void }) {
	return (
		<div className="grid grid-cols-2 gap-3 mb-10 w-full xl:grid-cols-4">
			<WebRecorderDialog
				trigger={
					<QuickActionTile
						accent
						icon={<Video className="size-[18px]" strokeWidth={2} />}
						title="Record in browser"
						hint="Screen, window, tab or camera"
					/>
				}
			/>
			<ChromeTile />
			<UploadCapButton
				renderTrigger={(onClick) => (
					<QuickActionTile
						icon={<Upload className="size-[18px]" strokeWidth={2} />}
						title="Import media"
						hint="Upload a file or import from Loom"
						onClick={onClick}
					/>
				)}
			/>
			<QuickActionTile
				icon={<FolderPlus className="size-[18px]" strokeWidth={2} />}
				title="New folder"
				hint="Keep related Caps together"
				onClick={onNewFolder}
			/>
		</div>
	);
}
