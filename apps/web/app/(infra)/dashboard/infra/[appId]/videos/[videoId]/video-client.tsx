"use client";

import clsx from "clsx";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { deleteDeveloperVideo } from "@/actions/developers/delete-video";
import { renameDeveloperVideo } from "@/actions/developers/rename-video";
import { CapPlayer } from "@/components/cap-player/CapPlayer";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { infraAppPath } from "@/lib/infra-routes";
import { formatBytes, formatDuration } from "@/lib/infra-usage";
import {
	type InfraVideoDetail,
	infraVideoDisplayState,
	infraVideoIsChanging,
} from "@/lib/infra-video-view";
import { KeyRow } from "../../../_components/copy";
import { ConfirmDialog } from "../../../_components/dialog";
import { useLiveRefresh } from "../../../_components/live-refresh";
import { actionMessage, runAction } from "../../../_components/run-action";
import {
	Block,
	Button,
	ButtonLink,
	FOCUS,
	Input,
	MONO,
	RULE,
} from "../../../_components/ui";
import { useLocalUpload } from "../../../_components/uploads";
import { VideoStatus } from "../../../_components/video-status";

const createdFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
	timeZone: "UTC",
	timeZoneName: "short",
});

function Notice({
	title,
	children,
	action,
}: {
	title: string;
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex aspect-video w-full flex-col items-start justify-center rounded-[12px] px-6 py-8 shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12)] sm:px-10">
			<h2 className="m-0 text-[15px] font-medium leading-[1.3] tracking-[-0.01em] text-[#E8ECF4]">
				{title}
			</h2>
			<p className="m-0 mt-2 max-w-[460px] text-pretty text-[13.5px] leading-[1.6] text-[rgba(232,236,244,0.58)]">
				{children}
			</p>
			{action && <div className="mt-5">{action}</div>}
		</div>
	);
}

function Player({ video }: { video: InfraVideoDetail }) {
	// The source is fixed when the player mounts, so a second format that
	// finishes encoding later does not restart a video someone is watching.
	const [source] = useState(() => ({
		hls: video.hlsUrl ?? undefined,
		mp4: video.mp4Url ?? undefined,
	}));
	const portrait =
		video.width !== null && video.height !== null && video.height > video.width;
	return (
		<div
			className={clsx(
				"overflow-hidden rounded-[12px] shadow-[0_0_0_1px_rgba(222,230,246,0.1)]",
				portrait && "max-w-[340px]",
			)}
		>
			<CapPlayer
				source={source}
				title={video.name}
				poster={video.posterUrl ?? undefined}
				aspectRatio={
					video.width && video.height
						? `${video.width} / ${video.height}`
						: undefined
				}
			/>
		</div>
	);
}

function Fact({
	label,
	note,
	children,
}: {
	label: string;
	note?: string;
	children: ReactNode;
}) {
	return (
		<div className={clsx("border-b py-3", RULE)}>
			<div className="flex items-baseline justify-between gap-6">
				<dt className="shrink-0 text-[13px] text-[rgba(232,236,244,0.5)]">
					{label}
				</dt>
				<dd className="m-0 min-w-0 truncate text-right text-[13.5px] text-[#E8ECF4]">
					{children}
				</dd>
			</div>
			{note && (
				<dd className="m-0 mt-1 text-pretty text-[12.5px] leading-[1.45] text-[rgba(232,236,244,0.42)]">
					{note}
				</dd>
			)}
		</div>
	);
}

export function VideoClient({
	appId,
	video,
	playbackPaused,
}: {
	appId: string;
	video: InfraVideoDetail;
	playbackPaused: boolean;
}) {
	const router = useRouter();
	const nameId = useId();
	const state = infraVideoDisplayState(video.state, useLocalUpload()(video.id));
	const uploadingHere = state === "uploading";
	const renameButton = useRef<HTMLButtonElement>(null);
	const wasRenaming = useRef(false);
	const [renaming, setRenaming] = useState(false);
	const [name, setName] = useState(video.name);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const videosPath = infraAppPath(appId, "videos");

	useLiveRefresh(
		!uploadingHere &&
			(infraVideoIsChanging(video, Date.now()) || video.stillEncoding),
	);

	useEffect(() => {
		if (wasRenaming.current && !renaming) renameButton.current?.focus();
		wasRenaming.current = renaming;
	}, [renaming]);

	const stopRenaming = () => {
		setName(video.name);
		setRenaming(false);
	};

	const rename = useEffectMutation({
		mutationFn: () =>
			runAction(() => renameDeveloperVideo(appId, video.id, name)),
		onSuccess: () => {
			setRenaming(false);
			toast.success("Video renamed");
			router.refresh();
		},
		onError: (cause) =>
			toast.error(actionMessage(cause, "Could not rename the video")),
	});

	const remove = useEffectMutation({
		mutationFn: () => runAction(() => deleteDeveloperVideo(appId, video.id)),
		onSuccess: () => {
			toast.success("Video deleted");
			router.push(videosPath);
		},
		onError: () => toast.error("Could not delete the video"),
	});

	const removeButton = (
		<Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
			Remove it
		</Button>
	);
	const playable = video.hlsUrl !== null || video.mp4Url !== null;
	const duration = formatDuration(video.duration);
	const size = formatBytes(video.storedBytes);
	const links = [
		{ label: "HLS", value: video.hlsUrl },
		{ label: "MP4", value: video.mp4Url },
		{ label: "Poster", value: video.posterUrl },
	].flatMap((link) =>
		link.value ? [{ label: link.label, value: link.value }] : [],
	);

	return (
		<>
			<div>
				<Link
					href={videosPath}
					className={clsx(
						"inline-flex items-center gap-1.5 rounded-[6px] text-[13px] text-[rgba(232,236,244,0.5)] transition-colors duration-200 hover:text-[#E8ECF4]",
						FOCUS,
					)}
				>
					<ArrowLeft size={13} aria-hidden="true" />
					Videos
				</Link>
				<header className="mt-4 flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
					<div className="min-w-0 flex-1 basis-[280px]">
						{renaming ? (
							<form
								className="flex flex-wrap items-center gap-2"
								onKeyDown={(e) => {
									if (e.key === "Escape" && !rename.isPending) stopRenaming();
								}}
								onSubmit={(e) => {
									e.preventDefault();
									if (!name.trim() || rename.isPending) return;
									if (name.trim() === video.name) {
										setRenaming(false);
										return;
									}
									rename.mutate();
								}}
							>
								<label htmlFor={nameId} className="sr-only">
									Video name
								</label>
								<Input
									id={nameId}
									value={name}
									maxLength={255}
									autoFocus
									autoComplete="off"
									onChange={(e) => setName(e.target.value)}
									className="h-10 min-w-[12rem] max-w-[420px] flex-1"
								/>
								<Button
									type="submit"
									disabled={!name.trim()}
									loading={rename.isPending}
								>
									Save
								</Button>
								<Button
									variant="quiet"
									disabled={rename.isPending}
									onClick={stopRenaming}
								>
									Cancel
								</Button>
							</form>
						) : (
							<h1 className="m-0 truncate text-[26px] font-medium leading-[1.15] tracking-[-0.03em] text-[#E8ECF4]">
								{video.name}
							</h1>
						)}
						<VideoStatus state={state} className="mt-3" />
					</div>
					{!renaming && (
						<div className="flex shrink-0 gap-2">
							<Button
								ref={renameButton}
								variant="ghost"
								onClick={() => {
									setName(video.name);
									setRenaming(true);
								}}
							>
								Rename
							</Button>
							<Button
								variant="danger"
								disabled={uploadingHere}
								onClick={() => setConfirmDelete(true)}
							>
								Delete
							</Button>
						</div>
					)}
				</header>
			</div>

			<div className="grid items-start gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
				<div className="min-w-0">
					{video.state === "ready" && playable && playbackPaused ? (
						<Notice
							title="Playback is paused"
							action={
								<ButtonLink size="sm" href={infraAppPath(appId, "billing")}>
									Add credits
								</ButtonLink>
							}
						>
							This app is out of credit, so its videos do not play here or
							anywhere they are embedded. They are still stored. Add credits and
							playback is back within about a minute.
						</Notice>
					) : video.state === "ready" && playable ? (
						<Player video={video} />
					) : video.state === "ready" ? (
						<Notice title="Nothing to play yet">
							This video was uploaded before Cap Infra encoded video, so it has
							no playback links. Upload the file again to get them.
						</Notice>
					) : state === "processing" ? (
						<Notice title="Processing">
							Cap is encoding this video. The player appears here on its own as
							soon as it is ready.
						</Notice>
					) : video.state === "failed" ? (
						<Notice title="Processing failed" action={removeButton}>
							{video.failure}
						</Notice>
					) : uploadingHere ? (
						<Notice title="Uploading">
							The upload carries on while you move around this app. Closing the
							tab or leaving Cap Infra cancels it.
						</Notice>
					) : (
						<Notice title="Upload not finished" action={removeButton}>
							The file has not arrived, so nothing is billed for it. If you
							refreshed or left the page during the upload, it stopped. Remove
							this and upload the file again. An upload still running somewhere
							else finishes on its own.
						</Notice>
					)}
				</div>

				<dl className={clsx("m-0 border-t", RULE)}>
					{duration && <Fact label="Duration">{duration}</Fact>}
					{size && (
						<Fact
							label="Stored size"
							note="The original file plus every encoded size. Storage is billed by the minute, not by size."
						>
							{size}
						</Fact>
					)}
					{video.width && video.height ? (
						<Fact label="Resolution">
							{video.width}×{video.height}
						</Fact>
					) : null}
					<Fact label="Uploaded">
						{createdFormat.format(new Date(video.createdAt))}
					</Fact>
					{video.externalUserId && (
						<Fact label="User id">
							<span className={clsx(MONO, "text-[13px]")}>
								{video.externalUserId}
							</span>
						</Fact>
					)}
				</dl>
			</div>

			{video.shareUrl && video.embedCode && (
				<Block
					title="Share and embed"
					description="A hosted player for this video. Send the link to a viewer, or paste the embed code into a page."
				>
					<KeyRow label="Share link" value={video.shareUrl} />
					<KeyRow label="Embed code" value={video.embedCode} />
				</Block>
			)}

			<Block
				title="Links"
				description={
					links.length > 0
						? "Paste these into your site, app or player. They stay the same for the life of the video."
						: "Playback links appear here once the video is ready."
				}
			>
				{links.map((link) => (
					<KeyRow key={link.label} label={link.label} value={link.value} />
				))}
				<KeyRow label="Video id" value={video.id} />
				{video.stillEncoding && (
					<p className="m-0 mt-3 text-pretty text-[13px] leading-[1.55] text-[rgba(232,236,244,0.46)]">
						One format is still encoding. Its link is added here when it is
						done.
					</p>
				)}
			</Block>

			{video.sizes.length > 0 && (
				<Block
					title="Encoded sizes"
					description="The player picks the best one for each viewer's screen and connection."
				>
					<ul className="m-0 list-none p-0">
						{video.sizes.map((encoded) => (
							<li
								key={encoded.name}
								className={clsx(
									"flex items-baseline justify-between gap-6 border-b py-3",
									RULE,
								)}
							>
								<span className="text-[13.5px] text-[#E8ECF4]">
									{encoded.name}
								</span>
								<span
									className={clsx(
										MONO,
										"flex gap-6 text-[13px] tabular-nums text-[rgba(232,236,244,0.72)]",
									)}
								>
									<span>
										{encoded.width}×{encoded.height}
									</span>
									<span className="w-16 text-right">
										{formatBytes(encoded.bytes)}
									</span>
								</span>
							</li>
						))}
					</ul>
				</Block>
			)}

			<ConfirmDialog
				open={confirmDelete}
				title={state === "unfinished" ? "Remove upload" : "Delete video"}
				description={
					state === "unfinished"
						? `Remove "${video.name}"? Its file has not arrived. An upload still running somewhere else will fail.`
						: `Delete "${video.name}"? Its links stop playing within about a minute, its files are removed and it stops counting toward storage.`
				}
				confirmLabel={state === "unfinished" ? "Remove" : "Delete"}
				loading={remove.isPending}
				onConfirm={() => remove.mutate()}
				onCancel={() => {
					if (!remove.isPending) setConfirmDelete(false);
				}}
			/>
		</>
	);
}
