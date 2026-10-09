"use client";

import clsx from "clsx";
import { type CSSProperties, useState } from "react";
import { InkLoader } from "@/components/ink-loader";
import "./editor-loading.css";

const SIDEBAR_TABS = 5;
const SIDEBAR_ROWS = [64, 48, 80, 56, 72];

function Pill({ width, className }: { width: number; className?: string }) {
	return <span className={clsx("edl-pill", className)} style={{ width }} />;
}

/**
 * The editor as it will look, drawn by the page from the first moment so the
 * switch from the share page is one continuous screen: the same bar, every
 * card at its final size, the recording's frame where the preview will be.
 * The editor loads beneath it and this fades away once it shows a frame of
 * its own. Kept in step with the editor's layout (Editor.tsx, Player.tsx and
 * web-layout.css).
 */
export function EditorLoading({
	title,
	poster,
	timelineRows,
	timelineHeight,
	leaving,
	playing,
	onPlay,
	slowMessage,
}: {
	title: string;
	poster: string | null;
	timelineRows: number;
	timelineHeight: number | null;
	leaving: boolean;
	playing: boolean;
	onPlay: () => void;
	slowMessage: string | null;
}) {
	const [aspect, setAspect] = useState(16 / 9);
	return (
		<section
			className="cap-rec edl"
			data-appearance="light"
			data-leaving={leaving || undefined}
			aria-busy="true"
			aria-label="Opening the editor"
			style={
				{
					"--edl-aspect": aspect,
					"--edl-hug": `${46 + timelineRows * 50}px`,
					...(timelineHeight === null
						? {}
						: { "--edl-timeline": `${timelineHeight}px` }),
				} as CSSProperties
			}
		>
			<div className="edl-header">
				<span
					className="edl-pill edl-title"
					style={{ width: Math.min(480, Math.max(80, title.length * 6.6)) }}
				>
					<span className="sr-only">{title}</span>
				</span>
				<span className="edl-spacer" />
				<Pill width={64} className="edl-wide-only" />
				<Pill width={76} className="edl-wide-only" />
				<span className="edl-pill edl-save" />
			</div>
			<div className="edl-grid">
				<div className="edl-card edl-player">
					<div className="edl-toolbar">
						<Pill width={56} />
						<Pill width={48} />
						<Pill width={60} />
						<span className="edl-spacer" />
						<Pill width={172} className="edl-wide-only" />
					</div>
					<div className="edl-stage">
						<div className="edl-fit">
							<div
								className="edl-preview"
								data-poster={poster ? "" : undefined}
								style={{ viewTransitionName: "cap-edit-video" }}
							>
								{poster && (
									<img
										src={poster}
										alt=""
										className="edl-poster"
										onLoad={(event) => {
											const image = event.currentTarget;
											if (image.naturalWidth > 0 && image.naturalHeight > 0)
												setAspect(image.naturalWidth / image.naturalHeight);
										}}
									/>
								)}
								{poster && <div className="edl-shade" />}
								<div className="edl-status">
									<InkLoader size="lg" tone={poster ? "media" : "muted"} />
									{slowMessage && (
										<output className="edl-slow">{slowMessage}</output>
									)}
								</div>
							</div>
						</div>
					</div>
					<div className="edl-transport">
						<span className="edl-transport-side">
							<Pill width={92} />
						</span>
						<span className="edl-controls">
							<span className="edl-skip">
								<svg viewBox="0 0 12 15" aria-hidden="true">
									<path d="M12 1.491V13.509a1.2 1.2 0 0 1-1.832 1.007L1.2 8.908V14.1a.6.6 0 0 1-1.2 0V.9a.6.6 0 0 1 1.2 0v5.192L10.168.484A1.2 1.2 0 0 1 12 1.491Z" />
								</svg>
							</span>
							<span className="edl-play-slot">
								<button
									type="button"
									className="edl-play"
									aria-label={playing ? "Pause video" : "Play video"}
									aria-busy={playing || undefined}
									onClick={onPlay}
								>
									{playing ? (
										<svg viewBox="0 0 17 19" aria-hidden="true">
											<path d="M16.659 2.145v15c0 .829-.672 1.5-1.5 1.5h-3.75c-.829 0-1.5-.671-1.5-1.5v-15c0-.828.671-1.5 1.5-1.5h3.75c.828 0 1.5.672 1.5 1.5Zm-11.25-1.5h-3.75c-.829 0-1.5.672-1.5 1.5v15c0 .829.671 1.5 1.5 1.5h3.75c.828 0 1.5-.671 1.5-1.5v-15c0-.828-.672-1.5-1.5-1.5Z" />
										</svg>
									) : (
										<svg viewBox="0 0 10 11" aria-hidden="true">
											<path d="M10 5.5a.68.68 0 0 1-.432.65L1.382 10.387A1 1 0 0 1 0 9.737V1.263A1 1 0 0 1 1.382.613l8.186 4.237A.68.68 0 0 1 10 5.5Z" />
										</svg>
									)}
									{playing && <span className="edl-play-ring" />}
								</button>
							</span>
							<span className="edl-skip">
								<svg viewBox="0 0 12 15" aria-hidden="true">
									<path d="M12 .9v13.2a.6.6 0 0 1-1.2 0V8.908l-8.968 5.608A1.2 1.2 0 0 1 0 13.509V1.491A1.2 1.2 0 0 1 1.832.484L10.8 6.092V.9a.6.6 0 0 1 1.2 0Z" />
								</svg>
							</span>
						</span>
						<span className="edl-transport-side edl-end">
							<Pill width={24} className="edl-wide-only" />
							<Pill width={96} className="edl-wide-only" />
						</span>
					</div>
				</div>
				<div className="edl-card edl-sheet">
					<div className="edl-tabs">
						{Array.from({ length: SIDEBAR_TABS }, (_, index) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
								key={index}
								className={clsx("edl-tab", index === 0 && "is-selected")}
							/>
						))}
					</div>
					<div className="edl-sheet-body">
						{SIDEBAR_ROWS.map((width) => (
							<span key={width} className="edl-row">
								<Pill width={width} />
								<Pill width={140} className="edl-row-control" />
							</span>
						))}
					</div>
				</div>
				<div className="edl-card edl-strip">
					<Pill width={56} />
					<span className="edl-clip" />
					<Pill width={84} />
				</div>
				<div className="edl-card edl-timeline">
					<div className="edl-ruler">
						<Pill width={88} className="edl-add-track" />
					</div>
					{Array.from({ length: timelineRows }, (_, index) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
							key={index}
							className="edl-track"
						>
							<span className="edl-track-tile" />
							<Pill width={40} className="edl-track-label" />
						</span>
					))}
				</div>
				<div className="edl-card edl-sheet-bar">
					{Array.from({ length: SIDEBAR_TABS }, (_, index) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
							key={index}
							className="edl-tab"
						/>
					))}
				</div>
			</div>
			<div className="edl-sheen" aria-hidden="true" />
		</section>
	);
}
