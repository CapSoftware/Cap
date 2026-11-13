"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRef, useState } from "react";
import { infraAppPath } from "@/lib/infra-routes";
import { Button, LIT, MONO, TEXT_LINK } from "./ui";
import { useUploads } from "./uploads";

export function UploadDrop() {
	const { appId, active, waiting, failures, add, cancel } = useUploads();
	const input = useRef<HTMLInputElement>(null);
	const [over, setOver] = useState(false);

	return (
		<section
			aria-label="Upload a video"
			onDragOver={(e) => {
				e.preventDefault();
				setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(e) => {
				e.preventDefault();
				setOver(false);
				add(Array.from(e.dataTransfer.files));
			}}
			className={clsx(
				"relative overflow-hidden rounded-[12px] px-5 py-5 transition-[background-color,box-shadow] duration-200",
				over
					? "bg-[rgba(222,230,246,0.05)] shadow-[inset_0_0_0_1px_rgba(232,236,244,0.7)]"
					: "shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12)]",
			)}
		>
			<input
				ref={input}
				type="file"
				accept="video/*,.mkv"
				multiple
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
				onChange={(e) => {
					add(Array.from(e.target.files ?? []));
					e.target.value = "";
				}}
			/>
			{active ? (
				<div className="flex items-center justify-between gap-5">
					<div className="min-w-0">
						<p className="m-0 truncate text-[14px] leading-[1.4] text-[#E8ECF4]">
							{active.name}
						</p>
						<p
							aria-live="polite"
							className="m-0 mt-1 text-[13px] leading-[1.4] text-[rgba(232,236,244,0.5)]"
						>
							{over
								? "Drop it to upload it next"
								: waiting > 0
									? `${active.label}, ${waiting} more waiting`
									: active.label}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-4">
						<span
							className={clsx(
								MONO,
								"text-[14px] tabular-nums tracking-[-0.02em] text-white",
							)}
						>
							{Math.round(active.progress * 100)}%
						</span>
						<Button
							variant="quiet"
							size="sm"
							disabled={active.locked && waiting === 0}
							onClick={cancel}
						>
							{waiting > 0 ? "Cancel all" : "Cancel"}
						</Button>
					</div>
					<span
						aria-hidden="true"
						className="absolute inset-x-0 bottom-0 h-px bg-[rgba(222,230,246,0.1)]"
					/>
					<span
						aria-hidden="true"
						style={{ width: `${Math.max(1, active.progress * 100)}%` }}
						className={clsx(
							"absolute bottom-0 left-0 h-[2px] rounded-full transition-[width] duration-300 ease-out",
							LIT,
						)}
					/>
				</div>
			) : (
				<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
					<div className="min-w-0">
						<p className="m-0 text-[14px] leading-[1.4] text-[#E8ECF4]">
							{over ? "Drop it to upload" : "Drop a video here to upload it"}
						</p>
						{failures.length === 0 && (
							<p className="m-0 mt-1 text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)]">
								MP4, MOV or WebM, one or several. Uploads are free, and stored
								video is billed by the minute.
							</p>
						)}
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => input.current?.click()}
					>
						Choose a file
					</Button>
				</div>
			)}
			{failures.length > 0 && (
				<ul
					role="alert"
					className={clsx(
						"m-0 flex list-none flex-col gap-1 p-0",
						active ? "mt-3" : "mt-1",
					)}
				>
					{failures.map((failure) => (
						<li
							key={failure.id}
							className="text-pretty text-[13px] leading-[1.5] text-[#F2A199]"
						>
							{failures.length > 1 && `${failure.name}: `}
							{failure.message}
							{failure.skipped > 0 &&
								` ${failure.skipped} more ${failure.skipped === 1 ? "file was" : "files were"} not started.`}{" "}
							{failure.needsCredits && (
								<Link
									href={infraAppPath(appId, "billing")}
									className={clsx(TEXT_LINK, "text-[#E8ECF4]")}
								>
									Add credits
								</Link>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
