"use client";

import type { comments as commentsSchema } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { ImageUpload, Video } from "@cap/web-domain";
import { useQuery } from "@tanstack/react-query";
import { useTranscript } from "hooks/use-transcript";
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
import { getEditorSavedRenderState } from "@/lib/editor-saved-render";
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

const SESSION_STORAGE_KEY = "cap_tb_session_id";
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const ensureAnalyticsSessionId = () => {
	if (typeof window === "undefined") return "anonymous";
	try {
		const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
		const now = Date.now();
		if (raw) {
			const parsed = JSON.parse(raw) as { value: string; expiry: number };
			if (parsed?.value && parsed.expiry > now) return parsed.value;
		}
		const newId =
			typeof crypto !== "undefined" && "randomUUID" in crypto
				? crypto.randomUUID()
				: Math.random().toString(36).slice(2);
		window.localStorage.setItem(
			SESSION_STORAGE_KEY,
			JSON.stringify({ value: newId, expiry: now + SESSION_TTL_MS }),
		);
		return newId;
	} catch (error) {
		console.warn("Failed to persist analytics session id", error);
		return "anonymous";
	}
};

const trackVideoView = (payload: {
	videoId: string;
	orgId?: string | null;
	ownerId?: string | null;
}) => {
	if (typeof window === "undefined") return;
	const sessionId = ensureAnalyticsSessionId();
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
		userAgent:
			typeof navigator !== "undefined" ? navigator.userAgent : undefined,
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

interface ShareProps {
	data: VideoData;
	comments: MaybePromise<CommentWithAuthor[]>;
	views: MaybePromise<number>;
	customDomain: string | null;
	domainVerified: boolean;
	videoSettings?: OrganizationSettings | null;
	userOrganizations?: { id: string; name: string }[];
	viewerId?: string | null;
	initialAiData?: {
		title?: string | null;
		summary?: string | null;
		chapters?: { title: string; start: number }[] | null;
		aiGenerationStatus?: AiGenerationStatus | null;
	} | null;
	aiGenerationEnabled: boolean;
}

const useVideoStatus = (
	videoId: Video.VideoId,
	aiGenerationEnabled: boolean,
	initialData?: {
		transcriptionStatus?: string | null;
		aiData?: {
			title?: string | null;
			summary?: string | null;
			chapters?: { title: string; start: number }[] | null;
			aiGenerationStatus?: AiGenerationStatus | null;
		} | null;
		editorSavedRender?: {
			status?: "QUEUED" | "PROCESSING" | "COMPLETE" | "ERROR" | null;
			progress?: number | null;
			message?: string | null;
			error?: string | null;
		} | null;
	},
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
					transcriptionStatus: initialData.transcriptionStatus as
						| "PROCESSING"
						| "COMPLETE"
						| "ERROR"
						| "SKIPPED"
						| "NO_AUDIO"
						| null,
					aiGenerationStatus:
						(initialData.aiData?.aiGenerationStatus as AiGenerationStatus) ||
						null,
					aiTitle: initialData.aiData?.title || null,
					summary: initialData.aiData?.summary || null,
					chapters: initialData.aiData?.chapters || null,
					editorSavedRenderStatus:
						initialData.editorSavedRender?.status || null,
					editorSavedRenderProgress:
						initialData.editorSavedRender?.progress || null,
					editorSavedRenderMessage:
						initialData.editorSavedRender?.message || null,
					editorSavedRenderError: initialData.editorSavedRender?.error || null,
				}
			: undefined,
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data) return 2000;

			const shouldContinuePolling = () => {
				if (
					data.editorSavedRenderStatus === "QUEUED" ||
					data.editorSavedRenderStatus === "PROCESSING"
				) {
					return true;
				}

				if (
					!data.transcriptionStatus ||
					data.transcriptionStatus === "PROCESSING"
				) {
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
					if (!aiGenerationEnabled) {
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

					if (!data.aiGenerationStatus && !data.summary && !data.chapters) {
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
	initialAiData,
	aiGenerationEnabled,
	videoSettings,
	viewerId,
}: ShareProps) => {
	const metadata = (data.metadata as VideoMetadata | null) || null;
	const initialEditorSavedRender = getEditorSavedRenderState(metadata);
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

	const { data: videoStatus } = useVideoStatus(data.id, aiGenerationEnabled, {
		transcriptionStatus: data.transcriptionStatus,
		aiData: initialAiData,
		editorSavedRender: initialEditorSavedRender
			? {
					status: initialEditorSavedRender.status,
					progress: initialEditorSavedRender.progress,
					message: initialEditorSavedRender.message,
					error: initialEditorSavedRender.error,
				}
			: null,
	});

	const transcriptionStatus =
		videoStatus?.transcriptionStatus || data.transcriptionStatus;
	const {
		data: transcriptContent,
		error: transcriptError,
		isLoading: isTranscriptLoading,
	} = useTranscript(data.id, transcriptionStatus);
	const hasTranscriptionTimedOut = useMemo(() => {
		const videoCreationTime = new Date(data.createdAt).getTime();
		const fiveMinutesInMs = 5 * 60 * 1000;
		return (
			Date.now() - videoCreationTime > fiveMinutesInMs && !transcriptionStatus
		);
	}, [data.createdAt, transcriptionStatus]);
	const transcriptUnavailable =
		transcriptionStatus === "COMPLETE" &&
		!isTranscriptLoading &&
		!transcriptContent &&
		Boolean(transcriptError);

	const aiData = useMemo(
		() => ({
			title: videoStatus?.aiTitle || null,
			summary: videoStatus?.summary || null,
			chapters: videoStatus?.chapters || null,
			aiGenerationStatus: videoStatus?.aiGenerationStatus || null,
		}),
		[videoStatus],
	);

	useEffect(() => {
		if (viewerId && viewerId === data.owner.id) {
			return;
		}

		trackVideoView({
			videoId: data.id,
			orgId: data.orgId,
			ownerId: data.owner.id,
		});
	}, [data.id, data.orgId, data.owner.id, viewerId]);

	const shouldShowLoading = () => {
		if (!aiGenerationEnabled) {
			return false;
		}

		if (!transcriptionStatus) {
			return !hasTranscriptionTimedOut;
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
			if (transcriptUnavailable) {
				return false;
			}

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
			if (!aiData.aiGenerationStatus && !aiData.summary && !aiData.chapters) {
				return true;
			}
		}

		return false;
	};

	const aiLoading = shouldShowLoading();
	const editorSavedRenderStatus =
		videoStatus?.editorSavedRenderStatus ||
		initialEditorSavedRender?.status ||
		null;
	const editorSavedRenderProgress =
		videoStatus?.editorSavedRenderProgress ??
		initialEditorSavedRender?.progress ??
		0;
	const editorSavedRenderMessage =
		videoStatus?.editorSavedRenderMessage ??
		initialEditorSavedRender?.message ??
		null;
	const isSavedRenderProcessing =
		editorSavedRenderStatus === "QUEUED" ||
		editorSavedRenderStatus === "PROCESSING";
	const hasSavedRender = editorSavedRenderStatus === "COMPLETE";

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

	const isDisabled = (setting: keyof NonNullable<OrganizationSettings>) =>
		videoSettings?.[setting] ?? data.orgSettings?.[setting] ?? false;

	const areChaptersDisabled = isDisabled("disableChapters");
	const isSummaryDisabled = isDisabled("disableSummary");
	const areCaptionsDisabled = isDisabled("disableCaptions");
	const areCommentStampsDisabled = isDisabled("disableComments");
	const areReactionStampsDisabled = isDisabled("disableReactions");
	const allSettingsDisabled =
		isDisabled("disableComments") &&
		isDisabled("disableSummary") &&
		isDisabled("disableTranscript");

	return (
		<CaptionProvider
			videoId={data.id}
			transcriptionStatus={transcriptionStatus}
		>
			<div className="mt-4">
				<div className="flex flex-col gap-4 lg:flex-row">
					<div className="flex-1">
						<div className="overflow-visible relative bg-white rounded-2xl border aspect-video border-gray-5">
							<div className="absolute inset-3 w-[calc(100%-1.5rem)] h-[calc(100%-1.5rem)] overflow-visible rounded-xl">
								<ShareVideo
									data={{ ...data, transcriptionStatus }}
									comments={comments}
									areChaptersDisabled={areChaptersDisabled}
									areCaptionsDisabled={areCaptionsDisabled}
									areCommentStampsDisabled={areCommentStampsDisabled}
									areReactionStampsDisabled={areReactionStampsDisabled}
									chapters={aiData?.chapters || []}
									aiGenerationStatus={aiData?.aiGenerationStatus}
									savedRenderProcessing={isSavedRenderProcessing}
									savedRenderProgress={editorSavedRenderProgress}
									savedRenderMessage={editorSavedRenderMessage}
									hasSavedRender={hasSavedRender}
									ref={playerRef}
								/>
							</div>
						</div>
						<div className="mt-4 lg:hidden">
							<Toolbar
								onOptimisticComment={handleOptimisticComment}
								onCommentSuccess={handleCommentSuccess}
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
								onSeek={handleSeek}
								videoId={data.id}
								aiData={aiData}
								aiGenerationEnabled={aiGenerationEnabled}
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
							disableReactions={
								videoSettings?.disableReactions ??
								data.orgSettings?.disableReactions
							}
							data={data}
						/>
					</div>
				</div>

				<div className="hidden mt-4 lg:block">
					{aiLoading && (
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

					<SummaryChapters
						isSummaryDisabled={isSummaryDisabled}
						areChaptersDisabled={areChaptersDisabled}
						handleSeek={handleSeek}
						aiData={aiData}
						aiLoading={aiLoading}
					/>
				</div>
			</div>
		</CaptionProvider>
	);
};
