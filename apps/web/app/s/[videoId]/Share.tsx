"use client";

import type { comments as commentsSchema } from "@cap/database/schema";
import type { ViewerSettingKey } from "@cap/web-backend";
import type { ImageUpload, Video } from "@cap/web-domain";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import {
	startTransition,
	use,
	useCallback,
	useEffect,
	useMemo,
	useOptimistic,
	useRef,
	useState,
} from "react";
import {
	getVideoStatus,
	type VideoStatusResult,
} from "@/actions/videos/get-status";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";
import { touchProductAnalyticsSession } from "@/app/utils/product-analytics";
import { CaptionProvider } from "./_components/CaptionContext";
import { ShareVideo } from "./_components/ShareVideo";
import { Sidebar } from "./_components/Sidebar";
import SummaryChapters from "./_components/SummaryChapters";
import { Toolbar } from "./_components/Toolbar";
import type { VideoData } from "./types";

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
	authorName: string | null;
	authorImage: ImageUpload.ImageUrl | null;
};

export type CommentType = typeof commentsSchema.$inferSelect & {
	authorName?: string | null;
	authorImage?: ImageUpload.ImageUrl | null;
	sending?: boolean;
};

const trackVideoView = (payload: {
	videoId: string;
	orgId?: string | null;
	ownerId?: string | null;
}) => {
	if (typeof window === "undefined") return;
	const sessionId = touchProductAnalyticsSession().sessionId;
	const screen = window.screen;
	const body = {
		videoId: payload.videoId,
		orgId: payload.orgId,
		ownerId: payload.ownerId,
		sessionId,
		pathname: window.location.pathname,
		href: window.location.href,
		referrer: document.referrer,
		hostname: window.location.hostname,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		language: typeof navigator !== "undefined" ? navigator.language : undefined,
		locale:
			typeof navigator !== "undefined" && navigator.languages?.length
				? navigator.languages[0]
				: undefined,
		screen: screen
			? {
					width: screen.width,
					height: screen.height,
					colorDepth: screen.colorDepth,
				}
			: undefined,
		occurredAt: new Date().toISOString(),
	};

	const serializedBody = JSON.stringify(body);

	if (
		typeof navigator !== "undefined" &&
		typeof navigator.sendBeacon === "function"
	) {
		try {
			const beaconPayload = new Blob([serializedBody], {
				type: "application/json",
			});
			const queued = navigator.sendBeacon(
				"/api/analytics/track",
				beaconPayload,
			);
			if (queued) {
				return;
			}
		} catch (error) {
			console.warn("Falling back to fetch for analytics tracking", error);
		}
	}

	void fetch("/api/analytics/track", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: serializedBody,
		keepalive: true,
	}).catch((error) => {
		if (error?.name !== "AbortError") {
			console.warn("Failed to track analytics event", error);
		}
	});
};

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

type TranscriptionStatus =
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED"
	| "NO_AUDIO";

interface ShareProps {
	data: VideoData;
	comments: MaybePromise<CommentWithAuthor[]>;
	views: MaybePromise<number>;
	screenshotImageUrl?: string | null;
	customDomain: string | null;
	domainVerified: boolean;
	videoSettings?: OrganizationSettings | null;
	userOrganizations?: { id: string; name: string }[];
	viewerId?: string | null;
	isEditProcessing: boolean;
	recordingStopped?: boolean;
	defaultPlaybackSpeed?: number;
	initialAiData?: {
		title?: string | null;
		summary?: string | null;
		chapters?: { title: string; start: number }[] | null;
		aiGenerationStatus?: AiGenerationStatus | null;
	} | null;
	aiGenerationAvailable: boolean;
	transcriptionGenerationAvailable: boolean;
}

const useVideoStatus = (
	videoId: Video.VideoId,
	availability: {
		aiGeneration: boolean;
		transcriptionGeneration: boolean;
	},
	initialData?: {
		transcriptionStatus?: string | null;
		name?: string | null;
		aiData?: {
			title?: string | null;
			summary?: string | null;
			chapters?: { title: string; start: number }[] | null;
			aiGenerationStatus?: AiGenerationStatus | null;
		} | null;
	},
	enabled: boolean = true,
) => {
	return useQuery({
		queryKey: ["videoStatus", videoId],
		queryFn: async (): Promise<VideoStatusResult> => {
			const res = await getVideoStatus(videoId);
			if ("success" in res && res.success === false)
				throw new Error("Failed to fetch video status");
			return res as VideoStatusResult;
		},
		initialData: initialData
			? {
					transcriptionStatus:
						initialData.transcriptionStatus as TranscriptionStatus | null,
					aiGenerationStatus:
						(initialData.aiData?.aiGenerationStatus as AiGenerationStatus) ||
						null,
					name: initialData.name ?? null,
					aiTitle: initialData.aiData?.title || null,
					summary: initialData.aiData?.summary || null,
					chapters: initialData.aiData?.chapters || null,
				}
			: undefined,
		enabled,
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data) return 2000;

			const shouldContinuePolling = () => {
				if (!data.transcriptionStatus) {
					return availability.transcriptionGeneration;
				}

				if (data.transcriptionStatus === "PROCESSING") {
					return true;
				}

				if (
					data.transcriptionStatus === "ERROR" ||
					data.transcriptionStatus === "SKIPPED" ||
					data.transcriptionStatus === "NO_AUDIO"
				) {
					return false;
				}

				if (data.transcriptionStatus === "COMPLETE") {
					if (!availability.aiGeneration) {
						return false;
					}

					if (
						data.aiGenerationStatus === "SKIPPED" ||
						data.aiGenerationStatus === "ERROR" ||
						data.aiGenerationStatus === "COMPLETE"
					) {
						return false;
					}

					if (
						data.aiGenerationStatus === "QUEUED" ||
						data.aiGenerationStatus === "PROCESSING"
					) {
						return true;
					}

					if (
						!data.aiGenerationStatus &&
						!data.summary &&
						!data.chapters?.length
					) {
						return true;
					}

					return false;
				}

				return false;
			};

			return shouldContinuePolling() ? 2000 : false;
		},
		refetchIntervalInBackground: false,
		staleTime: 1000,
	});
};

export const Share = ({
	data,
	comments,
	views,
	screenshotImageUrl,
	initialAiData,
	videoSettings,
	viewerId,
	isEditProcessing,
	recordingStopped = false,
	defaultPlaybackSpeed,
	aiGenerationAvailable,
	transcriptionGenerationAvailable,
}: ShareProps) => {
	const isScreenshot = data.isScreenshot === true;
	const effectiveDate: Date = data.metadata?.customCreatedAt
		? new Date(data.metadata.customCreatedAt)
		: data.createdAt;

	const playerRef = useRef<HTMLVideoElement | null>(null);
	const activityRef = useRef<{ scrollToBottom: () => void }>(null);
	const initialComments: CommentType[] =
		comments instanceof Promise ? use(comments) : comments;
	const [commentsData, setCommentsData] =
		useState<CommentType[]>(initialComments);
	const [optimisticComments, setOptimisticComments] = useOptimistic(
		commentsData,
		(state, newComment: CommentType) => {
			return [...state, newComment];
		},
	);

	const { data: videoStatus } = useVideoStatus(
		data.id,
		{
			aiGeneration: aiGenerationAvailable,
			transcriptionGeneration: transcriptionGenerationAvailable,
		},
		{
			transcriptionStatus: data.transcriptionStatus,
			name: data.name,
			aiData: initialAiData,
		},
		!isScreenshot,
	);

	const transcriptionStatus =
		videoStatus?.transcriptionStatus || data.transcriptionStatus;

	const aiData = useMemo(
		() => ({
			title: videoStatus?.aiTitle || null,
			summary: videoStatus?.summary || null,
			chapters: videoStatus?.chapters || null,
			aiGenerationStatus: videoStatus?.aiGenerationStatus || null,
		}),
		[videoStatus],
	);

	const viewTrackedRef = useRef(false);
	const handlePlaybackStarted = useCallback(() => {
		if (viewTrackedRef.current || viewerId === data.owner.id) return;
		viewTrackedRef.current = true;
		trackVideoView({
			videoId: data.id,
			orgId: data.orgId,
			ownerId: data.owner.id,
		});
	}, [data.id, data.orgId, data.owner.id, viewerId]);

	const isDisabled = (setting: ViewerSettingKey) =>
		videoSettings?.[setting] ?? data.orgSettings?.[setting] ?? false;

	const areChaptersDisabled = isScreenshot || isDisabled("disableChapters");
	const isSummaryDisabled = isScreenshot || isDisabled("disableSummary");
	const areCaptionsDisabled = isScreenshot || isDisabled("disableCaptions");
	const areCommentStampsDisabled = isDisabled("disableComments");
	const areReactionStampsDisabled = isDisabled("disableReactions");
	const allSettingsDisabled = isScreenshot
		? isDisabled("disableComments")
		: isDisabled("disableComments") &&
			isDisabled("disableSummary") &&
			isDisabled("disableTranscript");

	const shouldShowLoading = () => {
		const hasVisibleAiSection = !isSummaryDisabled || !areChaptersDisabled;
		const hasAiData = Boolean(aiData.summary || aiData.chapters?.length);

		if (!hasVisibleAiSection || !aiGenerationAvailable || hasAiData) {
			return false;
		}

		if (!transcriptionStatus) {
			return transcriptionGenerationAvailable;
		}

		if (transcriptionStatus === "PROCESSING") {
			return true;
		}

		if (
			transcriptionStatus === "ERROR" ||
			transcriptionStatus === "SKIPPED" ||
			transcriptionStatus === "NO_AUDIO"
		) {
			return false;
		}

		if (transcriptionStatus === "COMPLETE") {
			if (
				aiData.aiGenerationStatus === "SKIPPED" ||
				aiData.aiGenerationStatus === "ERROR" ||
				aiData.aiGenerationStatus === "COMPLETE"
			) {
				return false;
			}
			if (
				aiData.aiGenerationStatus === "QUEUED" ||
				aiData.aiGenerationStatus === "PROCESSING"
			) {
				return true;
			}
			if (!aiData.aiGenerationStatus) {
				return true;
			}
		}

		return false;
	};

	const aiLoading = shouldShowLoading();

	const searchParams = useSearchParams();
	const initialSeekDone = useRef(false);

	useEffect(() => {
		if (!searchParams.has("recordingStopped")) return;

		const url = new URL(window.location.href);
		url.searchParams.delete("recordingStopped");
		window.history.replaceState(
			window.history.state,
			"",
			`${url.pathname}${url.search}${url.hash}`,
		);
	}, [searchParams]);

	const handleSeek = useCallback((time: number) => {
		const v =
			playerRef.current ??
			(document.querySelector("video") as HTMLVideoElement | null);
		if (!v) {
			console.warn("Video player not ready");
			return;
		}
		const seekOnce = (t: number) => {
			const dur =
				Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
			const clamped = dur ? Math.max(0, Math.min(dur - 0.001, t)) : t;
			try {
				v.currentTime = clamped;
			} catch (e) {
				console.error("Failed to seek video:", e);
			}
		};
		if (v.readyState >= 1) {
			seekOnce(time);
			return;
		}
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const handleReady = () => {
			seekOnce(time);
			v.removeEventListener("canplay", handleReady);
			v.removeEventListener("loadedmetadata", handleReady);
			if (timeoutId) clearTimeout(timeoutId);
		};
		v.addEventListener("canplay", handleReady, { once: true });
		v.addEventListener("loadedmetadata", handleReady, { once: true });
		timeoutId = setTimeout(() => {
			v.removeEventListener("canplay", handleReady);
			v.removeEventListener("loadedmetadata", handleReady);
		}, 3000);
	}, []);

	useEffect(() => {
		if (initialSeekDone.current) return;
		const tParam = searchParams.get("t");
		if (isScreenshot) return;
		if (!tParam) return;
		const t = parseInt(tParam, 10);
		if (!Number.isFinite(t) || t < 0) return;

		const v =
			playerRef.current ??
			(document.querySelector("video") as HTMLVideoElement | null);
		if (v) {
			initialSeekDone.current = true;
			handleSeek(t);
			return;
		}

		const interval = setInterval(() => {
			const el =
				playerRef.current ??
				(document.querySelector("video") as HTMLVideoElement | null);
			if (el) {
				clearInterval(interval);
				initialSeekDone.current = true;
				handleSeek(t);
			}
		}, 200);

		const timeout = setTimeout(() => clearInterval(interval), 10000);

		return () => {
			clearInterval(interval);
			clearTimeout(timeout);
		};
	}, [searchParams, handleSeek, isScreenshot]);

	const handleOptimisticComment = useCallback(
		(comment: CommentType) => {
			startTransition(() => {
				setOptimisticComments(comment);
			});
			setTimeout(() => {
				activityRef.current?.scrollToBottom();
			}, 100);
		},
		[setOptimisticComments],
	);

	const handleCommentSuccess = useCallback((realComment: CommentType) => {
		startTransition(() => {
			setCommentsData((prev) => [...prev, realComment]);
		});
		setTimeout(() => {
			activityRef.current?.scrollToBottom();
		}, 100);
	}, []);

	return (
		<CaptionProvider
			videoId={data.id}
			transcriptionStatus={transcriptionStatus}
		>
			<div className="mt-4">
				<div className="flex flex-col gap-4 lg:flex-row">
					<div className="flex-1">
						<div className="overflow-visible relative bg-white rounded-2xl border aspect-video border-gray-5">
							<div
								className={
									isScreenshot
										? "absolute inset-3 w-[calc(100%-1.5rem)] h-[calc(100%-1.5rem)] overflow-visible rounded-xl"
										: "absolute inset-x-3 top-1/2 aspect-video -translate-y-1/2 overflow-visible rounded-xl"
								}
							>
								{isScreenshot ? (
									<ScreenshotImage src={screenshotImageUrl} alt={data.name} />
								) : (
									<ShareVideo
										data={{ ...data, transcriptionStatus }}
										comments={comments}
										areChaptersDisabled={areChaptersDisabled}
										areCaptionsDisabled={areCaptionsDisabled}
										areCommentStampsDisabled={areCommentStampsDisabled}
										areReactionStampsDisabled={areReactionStampsDisabled}
										chapters={aiData?.chapters || []}
										aiGenerationStatus={aiData?.aiGenerationStatus}
										canRetryProcessing={viewerId === data.owner.id}
										canFinalizeDesktopSegments={viewerId === data.owner.id}
										showPlaybackStatusBadge={viewerId === data.owner.id}
										isEditProcessing={isEditProcessing}
										recordingStopped={recordingStopped}
										defaultPlaybackSpeed={defaultPlaybackSpeed}
										onPlaybackStarted={handlePlaybackStarted}
										ref={playerRef}
									/>
								)}
							</div>
						</div>
						<div className="mt-4 lg:hidden">
							<Toolbar
								onOptimisticComment={handleOptimisticComment}
								onCommentSuccess={handleCommentSuccess}
								disableComments={areCommentStampsDisabled}
								disableReactions={areReactionStampsDisabled}
								data={data}
							/>
						</div>
					</div>

					{!allSettingsDisabled && (
						<div className="flex flex-col lg:w-80">
							<Sidebar
								data={{
									...data,
									createdAt: effectiveDate,
									transcriptionStatus,
								}}
								videoSettings={videoSettings}
								commentsData={commentsData}
								setCommentsData={setCommentsData}
								optimisticComments={optimisticComments}
								setOptimisticComments={setOptimisticComments}
								handleCommentSuccess={handleCommentSuccess}
								views={views}
								onSeek={isScreenshot ? undefined : handleSeek}
								isScreenshot={isScreenshot}
								videoId={data.id}
								aiData={aiData}
								aiGenerationEnabled={aiGenerationAvailable}
								ref={activityRef}
							/>
						</div>
					)}
				</div>

				<div className="hidden mt-4 lg:block">
					<div>
						<Toolbar
							onOptimisticComment={handleOptimisticComment}
							onCommentSuccess={handleCommentSuccess}
							disableComments={areCommentStampsDisabled}
							disableReactions={areReactionStampsDisabled}
							data={data}
						/>
					</div>
				</div>

				<div className="hidden mt-4 lg:block">
					{!isScreenshot && aiLoading && (
						<div className="p-4 animate-pulse new-card-style">
							<div className="space-y-6">
								<div>
									<div className="mb-3 w-24 h-6 bg-gray-200 rounded"></div>
									<div className="mb-4 w-32 h-3 bg-gray-100 rounded"></div>
									<div className="space-y-3">
										<div className="w-full h-4 bg-gray-200 rounded"></div>
										<div className="w-5/6 h-4 bg-gray-200 rounded"></div>
										<div className="w-4/5 h-4 bg-gray-200 rounded"></div>
										<div className="w-full h-4 bg-gray-200 rounded"></div>
										<div className="w-3/4 h-4 bg-gray-200 rounded"></div>
									</div>
								</div>

								<div>
									<div className="mb-4 w-24 h-6 bg-gray-200 rounded"></div>
									<div className="space-y-2">
										{[1, 2, 3, 4].map((i) => (
											<div key={i} className="flex items-center p-2">
												<div className="mr-3 w-12 h-4 bg-gray-200 rounded"></div>
												<div className="flex-1 h-4 bg-gray-200 rounded"></div>
											</div>
										))}
									</div>
								</div>
							</div>
						</div>
					)}

					{!isScreenshot && (
						<SummaryChapters
							isSummaryDisabled={isSummaryDisabled}
							areChaptersDisabled={areChaptersDisabled}
							handleSeek={handleSeek}
							aiData={aiData}
							aiLoading={aiLoading}
						/>
					)}
				</div>
			</div>
		</CaptionProvider>
	);
};

function ScreenshotImage({ src, alt }: { src?: string | null; alt: string }) {
	if (!src) {
		return (
			<div className="flex size-full items-center justify-center rounded-xl bg-gray-2 text-sm text-gray-10">
				Screenshot unavailable
			</div>
		);
	}

	return (
		<div className="relative size-full rounded-xl">
			<Image
				src={src}
				alt={alt}
				fill
				priority
				unoptimized
				sizes="100vw"
				className="rounded-xl object-contain"
			/>
		</div>
	);
}
