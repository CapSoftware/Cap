import type { comments as commentsSchema } from "@cap/database/schema";
import { classNames } from "@cap/utils";
import type { ImageUpload, Video } from "@cap/web-domain";
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { forwardRef, Suspense, useState } from "react";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { VideoData } from "../types";
import { Activity } from "./tabs/Activity";
import { Settings } from "./tabs/Settings";
import { Summary } from "./tabs/Summary";
import { Transcript } from "./tabs/Transcript";

type TabType = "activity" | "transcript" | "summary" | "settings";

type CommentType = typeof commentsSchema.$inferSelect & {
	authorName?: string | null;
	authorImage?: ImageUpload.ImageUrl | null;
};

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

interface SidebarProps {
	data: VideoData;
	commentsData: CommentType[];
	optimisticComments: CommentType[];
	handleCommentSuccess: (comment: CommentType) => void;
	setOptimisticComments: (newComment: CommentType) => void;
	setCommentsData: React.Dispatch<React.SetStateAction<CommentType[]>>;
	views: MaybePromise<number>;
	onSeek?: (time: number) => void;
	videoSettings?: OrganizationSettings | null;
	videoId: Video.VideoId;
	aiData?: {
		title?: string | null;
		summary?: string | null;
		chapters?: { title: string; start: number }[] | null;
		aiGenerationStatus?: AiGenerationStatus | null;
	} | null;
	aiGenerationEnabled?: boolean;
	isScreenshot?: boolean;
	/** The owner just stopped this recording and landed here from the desktop
	 * app — surface the transcript, which is the thing appearing live. */
	recordingStopped?: boolean;
	/** Owner is on Pro and the viewer is signed in; the composer's record
	 * buttons ride on the same gate the timeline's do. */
	canRecordMedia?: boolean;
	/** Supplied on desktop, where the rail can be folded away. */
	onCollapse?: () => void;
}

const TabContent = motion.div;

const tabVariants = {
	enter: (direction: number) => ({
		x: direction > 0 ? 1000 : -1000,
		opacity: 0,
	}),
	center: {
		zIndex: 1,
		x: 0,
		opacity: 1,
	},
	exit: (direction: number) => ({
		zIndex: 0,
		x: direction < 0 ? 1000 : -1000,
		opacity: 0,
	}),
};

const tabTransition = {
	x: { type: "spring", stiffness: 300, damping: 30 },
	opacity: { duration: 0.2 },
} as const;

export const Sidebar = forwardRef<{ scrollToBottom: () => void }, SidebarProps>(
	(
		{
			data,
			commentsData,
			setCommentsData,
			optimisticComments,
			handleCommentSuccess,
			setOptimisticComments,
			views,
			videoSettings,
			onSeek,
			aiData,
			aiGenerationEnabled = false,
			isScreenshot = false,
			recordingStopped = false,
			canRecordMedia = false,
			onCollapse,
		},
		ref,
	) => {
		const user = useCurrentUser();

		const isOwner = Boolean(user?.id === data.owner.id);
		const isOwnerOrMember = Boolean(
			isOwner || (user && data.organizationMembers?.includes(user.id)),
		);

		const transcriptDisabled =
			videoSettings?.disableTranscript ?? data.orgSettings?.disableTranscript;

		const defaultTab =
			// Landing right after stopping a recording: the transcript is what's
			// appearing within seconds — show it instead of empty comments.
			recordingStopped && !isScreenshot && !transcriptDisabled
				? "transcript"
				: isScreenshot ||
						!(
							videoSettings?.disableComments ??
							data.orgSettings?.disableComments
						)
					? "activity"
					: !(videoSettings?.disableSummary ?? data.orgSettings?.disableSummary)
						? "summary"
						: !transcriptDisabled
							? "transcript"
							: "activity";

		const [activeTab, setActiveTab] = useState<TabType>(defaultTab);
		const [[page, direction], setPage] = useState([0, 0]);

		const tabs = [
			{
				id: "activity",
				label: "Comments",
				disabled:
					videoSettings?.disableComments ?? data.orgSettings?.disableComments,
			},
			...(isScreenshot
				? []
				: [
						{
							id: "summary",
							label: "Summary",
							disabled:
								videoSettings?.disableSummary ??
								data.orgSettings?.disableSummary,
						},
						{
							id: "transcript",
							label: "Transcript",
							disabled:
								videoSettings?.disableTranscript ??
								data.orgSettings?.disableTranscript,
						},
					]),
		];

		const paginate = (tabId: TabType) => {
			const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
			const newIndex = tabs.findIndex((tab) => tab.id === tabId);
			const direction = newIndex > currentIndex ? 1 : -1;

			setPage([page + direction, direction]);
			setActiveTab(tabId);
		};

		const renderTabContent = () => {
			switch (activeTab) {
				case "activity":
					return (
						<Suspense
							fallback={<Activity.Skeleton isOwnerOrMember={isOwnerOrMember} />}
						>
							<Activity
								ref={ref}
								views={views}
								comments={commentsData}
								commentsDisabled={
									videoSettings?.disableComments ??
									data.orgSettings?.disableComments ??
									false
								}
								setComments={setCommentsData}
								optimisticComments={optimisticComments}
								setOptimisticComments={setOptimisticComments}
								handleCommentSuccess={handleCommentSuccess}
								isOwnerOrMember={isOwnerOrMember}
								isOwner={isOwner}
								onSeek={onSeek}
								videoId={data.id}
								ownerName={data.owner.name}
								canRecordMedia={canRecordMedia && !isScreenshot}
							/>
						</Suspense>
					);
				case "summary":
					return (
						<Summary
							videoId={data.id}
							ownerIsPro={data.owner.isPro}
							onSeek={onSeek}
							isSummaryDisabled={videoSettings?.disableSummary}
							initialAiData={aiData || undefined}
							aiGenerationEnabled={aiGenerationEnabled}
						/>
					);
				case "transcript":
					return <Transcript data={data} onSeek={onSeek} />;
				case "settings":
					return <Settings />;
				default:
					return null;
			}
		};

		const allTabsDisabled = tabs.every((tab) => tab.disabled);

		// Desktop: a flush pane that fills its rail, so the comment list gets the
		// viewport's height rather than the video's. Phones keep the card.
		return (
			<div className="bg-white rounded-2xl border border-gray-5 overflow-hidden h-[70svh] flex flex-col lg:h-full lg:rounded-none lg:border-0">
				<div className="flex-none">
					<div
						className={clsx(
							"flex border-b border-gray-5",
							allTabsDisabled && "hidden",
						)}
					>
						{tabs
							.filter((tab) => !tab.disabled)
							.map((tab) => (
								<button
									type="button"
									key={tab.id}
									onClick={() => paginate(tab.id as TabType)}
									className={classNames(
										"flex-1 px-5 py-3 text-sm font-medium relative transition-colors duration-200",
										"hover:bg-gray-1",
										activeTab === tab.id ? "bg-gray-3" : "",
									)}
								>
									<span
										className={classNames(
											"relative z-10 text-sm",
											activeTab === tab.id ? "text-gray-12" : "text-gray-9",
										)}
									>
										{tab.label}
									</span>
									{activeTab === tab.id && (
										<motion.div
											layoutId="activeTab"
											className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500"
											initial={false}
											transition={{
												type: "spring",
												stiffness: 500,
												damping: 30,
											}}
										/>
									)}
								</button>
							))}
						{onCollapse && (
							<button
								type="button"
								onClick={onCollapse}
								aria-label="Hide comments"
								title="Hide comments"
								className="hidden shrink-0 items-center justify-center px-3 text-gray-9 transition-colors hover:bg-gray-1 hover:text-gray-12 lg:flex"
							>
								<svg
									viewBox="0 0 16 16"
									className="size-4 fill-current"
									aria-hidden
								>
									<title>Hide comments</title>
									<path d="M5.7 3.3a.6.6 0 0 0 0 .85L9.55 8 5.7 11.85a.6.6 0 1 0 .85.85l4.27-4.27a.6.6 0 0 0 0-.86L6.55 3.3a.6.6 0 0 0-.85 0Z" />
								</svg>
							</button>
						)}
					</div>
				</div>
				<div className="flex-1 min-h-0">
					<div className="overflow-hidden relative h-full">
						<AnimatePresence initial={false} custom={direction}>
							<TabContent
								key={activeTab}
								custom={direction}
								variants={tabVariants}
								initial="enter"
								animate="center"
								exit="exit"
								transition={tabTransition}
								className="overflow-auto absolute inset-0"
							>
								<div className="h-full">{renderTabContent()}</div>
							</TabContent>
						</AnimatePresence>
					</div>
				</div>
			</div>
		);
	},
);
