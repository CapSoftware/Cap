"use client";

import type { comments as commentsSchema } from "@cap/database/schema";
import type { ViewerSettingKey } from "@cap/web-backend";
import type { ImageUpload } from "@cap/web-domain";
import clsx from "clsx";
import { useReducedMotion } from "motion/react";
import {
	type ReactNode,
	startTransition,
	use,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useOptimistic,
	useRef,
	useState,
} from "react";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";
import { Sidebar } from "./_components/Sidebar";
import { Toolbar } from "./_components/Toolbar";
import { trackVideoView } from "./_components/track-video-view";
import type { CommentType } from "./Share";
import type { VideoData } from "./types";

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
	authorName: string | null;
	authorImage: ImageUpload.ImageUrl | null;
};

export function NoteShare({
	data,
	header,
	document: noteDocument,
	transcript,
	comments,
	views,
	videoSettings,
	viewerId,
}: {
	data: VideoData;
	header: ReactNode;
	document: ReactNode;
	transcript: ReactNode | null;
	comments: MaybePromise<CommentWithAuthor[]>;
	views: MaybePromise<number>;
	videoSettings?: OrganizationSettings | null;
	viewerId?: string | null;
}) {
	const customCreatedAt = data.metadata?.customCreatedAt;
	const effectiveDate = useMemo(
		() => (customCreatedAt ? new Date(customCreatedAt) : data.createdAt),
		[customCreatedAt, data.createdAt],
	);

	const activityRef = useRef<{ scrollToBottom: () => void }>(null);
	const initialComments: CommentType[] =
		comments instanceof Promise ? use(comments) : comments;
	const [commentsData, setCommentsData] =
		useState<CommentType[]>(initialComments);
	const [optimisticComments, setOptimisticComments] = useOptimistic(
		commentsData,
		(state, newComment: CommentType) => [...state, newComment],
	);

	useEffect(() => {
		if (viewerId && viewerId === data.owner.id) return;
		trackVideoView({
			videoId: data.id,
			orgId: data.orgId,
			ownerId: data.owner.id,
		});
	}, [data.id, data.orgId, data.owner.id, viewerId]);

	const isDisabled = (setting: ViewerSettingKey) =>
		videoSettings?.[setting] ?? data.orgSettings?.[setting] ?? false;
	const commentsDisabled = isDisabled("disableComments");
	const reactionsDisabled = isDisabled("disableReactions");
	const shownTranscript = isDisabled("disableTranscript") ? null : transcript;
	const showRail = !commentsDisabled || shownTranscript !== null;

	const handleOptimisticComment = useCallback(
		(comment: CommentType) => {
			startTransition(() => {
				setOptimisticComments(comment);
			});
			setTimeout(() => activityRef.current?.scrollToBottom(), 100);
		},
		[setOptimisticComments],
	);

	const handleCommentSuccess = useCallback((realComment: CommentType) => {
		startTransition(() => {
			setCommentsData((prev) => [...prev, realComment]);
		});
		setTimeout(() => activityRef.current?.scrollToBottom(), 100);
	}, []);

	const visibleComments = useMemo(() => {
		const settledKeys = new Set<string>();
		for (const comment of optimisticComments)
			if (!comment.sending && comment.clientKey)
				settledKeys.add(comment.clientKey);
		if (settledKeys.size === 0) return optimisticComments;
		return optimisticComments.filter(
			(comment) => !(comment.sending && settledKeys.has(comment.id)),
		);
	}, [optimisticComments]);

	const sidebarData = useMemo(
		() => ({ ...data, createdAt: effectiveDate }),
		[data, effectiveDate],
	);

	const reduceMotion = useReducedMotion() ?? false;
	const sidebarId = useId();
	const [railCollapsed, setRailCollapsed] = useState(false);
	const toggleRail = useCallback(() => {
		setRailCollapsed((collapsed) => !collapsed);
	}, []);

	return (
		<>
			<div className="shrink-0 border-b border-gray-5 bg-white px-4 lg:px-8">
				{header}
			</div>
			<div className="flex flex-col flex-1 min-h-0 lg:flex-row">
				<div className="flex flex-col flex-1 min-w-0 lg:overflow-y-auto">
					<div className="px-4 mx-auto w-full max-w-[80rem] lg:px-8">
						<div className="flex flex-col gap-4 pb-8 mt-4">
							{noteDocument}
							{(!commentsDisabled || !reactionsDisabled || showRail) && (
								<div
									className={clsx(
										"relative",
										showRail && railCollapsed && "lg:min-h-10 lg:px-40",
									)}
								>
									<Toolbar
										onOptimisticComment={handleOptimisticComment}
										onCommentSuccess={handleCommentSuccess}
										disableComments={commentsDisabled}
										disableReactions={reactionsDisabled}
										data={data}
									/>
									{showRail && railCollapsed && (
										<button
											type="button"
											onClick={toggleRail}
											aria-controls={sidebarId}
											aria-expanded={false}
											className="hidden absolute right-0 top-1/2 gap-2 justify-center items-center px-3 h-10 text-sm font-medium bg-white rounded-lg border shadow-sm transition-colors -translate-y-1/2 border-gray-5 text-gray-10 hover:text-gray-12 lg:flex"
										>
											<svg
												viewBox="0 0 16 16"
												className="size-4 fill-current"
												aria-hidden
											>
												<title>Expand</title>
												<path d="M10.3 3.3a.6.6 0 0 1 0 .85L6.45 8l3.85 3.85a.6.6 0 1 1-.85.85l-4.27-4.27a.6.6 0 0 1 0-.86L9.45 3.3a.6.6 0 0 1 .85 0Z" />
											</svg>
											Show sidebar
										</button>
									)}
								</div>
							)}
						</div>
					</div>
				</div>
				{showRail && (
					<aside
						id={sidebarId}
						className={clsx(
							"shrink-0 px-4 pb-8 lg:p-0 lg:h-full lg:border-l lg:border-gray-5 lg:bg-white lg:overflow-hidden",
							reduceMotion
								? undefined
								: "lg:transition-[width] lg:duration-300 lg:ease-out",
							railCollapsed ? "lg:w-0" : "lg:w-[22rem] xl:w-[24rem]",
						)}
					>
						<div
							className={clsx(
								"lg:h-full lg:w-[22rem] xl:w-[24rem]",
								railCollapsed && "lg:invisible",
							)}
						>
							<Sidebar
								sidebarId={sidebarId}
								data={sidebarData}
								videoSettings={videoSettings}
								commentsData={commentsData}
								setCommentsData={setCommentsData}
								optimisticComments={visibleComments}
								setOptimisticComments={setOptimisticComments}
								handleCommentSuccess={handleCommentSuccess}
								views={views}
								videoId={data.id}
								isNote
								noteTranscript={shownTranscript}
								onCollapse={toggleRail}
								ref={activityRef}
							/>
						</div>
					</aside>
				)}
			</div>
		</>
	);
}
