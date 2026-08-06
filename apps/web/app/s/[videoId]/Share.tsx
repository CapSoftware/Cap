"use client";

import type { comments as commentsSchema } from "@cap/database/schema";
import type { ViewerSettingKey } from "@cap/web-backend";
import type { ImageUpload, Video } from "@cap/web-domain";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import {
	Suspense,
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
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { CaptionProvider } from "./_components/CaptionContext";
import { PlaybackProvider } from "./_components/playback/PlaybackContext";
import { ShareVideo } from "./_components/ShareVideo";
import { type ShareView, ShareViewToggle } from "./_components/ShareViewToggle";
import { Sidebar } from "./_components/Sidebar";
import SummaryChapters from "./_components/SummaryChapters";
import { Toolbar } from "./_components/Toolbar";
import { formatTimeAgo } from "./_components/tabs/Activity/utils";
import { TimelineSkeleton } from "./_components/timeline/TimelineSkeleton";
import type { FilmstripSource } from "./_components/timeline/useFilmstripFrames";
import type { VideoData } from "./types";

const importTimelineView = () => import("./_components/timeline/TimelineView");
const TimelineView = dynamic(importTimelineView, { ssr: false });

/** Whether the viewer last left the comments rail collapsed. */
const RAIL_COLLAPSED_KEY = "cap_share_rail_collapsed";

/**
 * The interactive walkthrough behind the header's "How does this work?".
 * Relative, so a custom domain or a self-hosted deployment links at its own
 * copy of the post rather than back at cap.so.
 */
const TIMELINE_GUIDE_URL = "/blog/timeline-view";

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
	authorName: string | null;
	authorImage: ImageUpload.ImageUrl | null;
};

export type CommentType = typeof commentsSchema.$inferSelect & {
	authorName?: string | null;
	authorImage?: ImageUpload.ImageUrl | null;
	sending?: boolean;
	/**
	 * The optimistic entry's temp id, carried onto the saved comment so lists
	 * can key the pair identically — the settle then updates the mounted card
	 * in place instead of remounting it (which would restart media playback).
	 */
	clientKey?: string;
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
	/** Server-resolved `?view=` so the first paint already has the right layout. */
	initialView?: ShareView;
	canRecordMedia?: boolean;
	viewerSignedIn?: boolean;
	/**
	 * The page header. Passed in rather than rendered above `Share` so the
	 * timeline view can swap it for a slim bar without the page owning which
	 * view is active.
	 */
	header?: React.ReactNode;
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
	initialView = "classic",
	canRecordMedia = false,
	viewerSignedIn = false,
	header,
}: ShareProps) => {
	const isScreenshot = data.isScreenshot === true;
	const effectiveDate: Date = data.metadata?.customCreatedAt
		? new Date(data.metadata.customCreatedAt)
		: data.createdAt;

	const playerRef = useRef<HTMLVideoElement | null>(null);
	const stageRef = useRef<HTMLDivElement | null>(null);
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

	// If the settle ever commits the saved comment while its optimistic twin is
	// still applied, both would render under the same clientKey; keep only the
	// settled one. Almost always a no-op passthrough.
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

	const reduceMotion = useReducedMotion() ?? false;
	const [selectedView, setSelectedView] = useState<ShareView>(initialView);
	// Screenshots have no timeline to show, and a comments-disabled video has
	// nothing to branch — both stay on the classic layout even if someone
	// hand-writes `?view=timeline`.
	const timelineAvailable = !isScreenshot && !areCommentStampsDisabled;

	// Where the timeline's filmstrip frames come from. Mirrors the source split
	// in `ShareVideo`: instant recordings have a result.mp4 a bare <video> can
	// seek; everything else is an HLS playlist. A still-uploading segments
	// source gets no strip — its playlist is in flux and not worth hammering.
	const filmstripSource = useMemo<FilmstripSource | null>(() => {
		if (isScreenshot) return null;
		const sourceType = data.source.type;
		if (sourceType === "desktopMP4" || sourceType === "webMP4") {
			return {
				src: `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=mp4`,
				kind: "native",
			};
		}
		if (sourceType === "desktopSegments") {
			if (data.hasActiveUpload) return null;
			return {
				src: `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=segments-master`,
				kind: "hls",
			};
		}
		return {
			src: `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=video`,
			kind: "hls",
		};
	}, [
		isScreenshot,
		data.source.type,
		data.owner.id,
		data.id,
		data.hasActiveUpload,
	]);
	// The theater block hugs the video: width-driven height from the real
	// aspect ratio, capped so the deck below stays reachable without scrolling.
	const stageAspect =
		data.width && data.height && data.width > 0 && data.height > 0
			? data.width / data.height
			: 16 / 9;

	const view: ShareView = timelineAvailable ? selectedView : "classic";
	const [morphing, setMorphing] = useState(false);
	const [stageFullscreen, setStageFullscreen] = useState(false);
	const [timelineRecording, setTimelineRecording] = useState(false);
	// The deck row the player's control bar portals into while the timeline is
	// up. Null until the lazily-loaded deck mounts; the bar stays on the video
	// (and returns there for fullscreen, which hides the deck).
	const [controlsSlot, setControlsSlot] = useState<HTMLElement | null>(null);

	const setViewAndUrl = useCallback((next: ShareView) => {
		setSelectedView(next);
		if (typeof window === "undefined") return;
		const url = new URL(window.location.href);
		if (next === "timeline") url.searchParams.set("view", "timeline");
		else url.searchParams.delete("view");
		// replaceState, not router.replace: the view is a presentation detail and
		// a Next navigation here would re-render the tree and remount the player.
		window.history.replaceState(
			window.history.state,
			"",
			`${url.pathname}${url.search}${url.hash}`,
		);
	}, []);

	const prefetchTimeline = useCallback(() => {
		void importTimelineView();
	}, []);

	// A toggle mid-fullscreen would rip the video out of the fullscreen element,
	// so disable it for as long as the stage owns the screen.
	useEffect(() => {
		const syncFullscreen = () => {
			const active = document.fullscreenElement;
			// `contains` is inclusive, so this also covers the stage itself.
			setStageFullscreen(Boolean(active && stageRef.current?.contains(active)));
		};
		syncFullscreen();
		document.addEventListener("fullscreenchange", syncFullscreen);
		return () =>
			document.removeEventListener("fullscreenchange", syncFullscreen);
	}, []);

	// T flips Player/Timeline, under the same guards as the toggle itself.
	useEffect(() => {
		if (!timelineAvailable) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "t" && event.key !== "T") return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				target?.isContentEditable
			) {
				return;
			}
			if (stageFullscreen || timelineRecording) return;
			event.preventDefault();
			setViewAndUrl(view === "timeline" ? "classic" : "timeline");
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		timelineAvailable,
		stageFullscreen,
		timelineRecording,
		view,
		setViewAndUrl,
	]);

	const showRail = view === "classic" && !allSettingsDisabled;
	const [railCollapsed, setRailCollapsed] = useState(false);

	// Read after mount, not during render: the server has no idea what the
	// viewer collapsed last time, and guessing would hydrate the wrong width.
	useEffect(() => {
		try {
			setRailCollapsed(
				window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "true",
			);
		} catch {
			/* private mode; the default (open) is fine */
		}
	}, []);

	const toggleRail = useCallback(() => {
		// Persist outside the updater: React may invoke updater functions more
		// than once, and localStorage writes don't belong in render-adjacent code.
		const next = !railCollapsed;
		setRailCollapsed(next);
		try {
			window.localStorage.setItem(RAIL_COLLAPSED_KEY, String(next));
		} catch {
			/* not worth failing the toggle over */
		}
	}, [railCollapsed]);

	return (
		<CaptionProvider
			videoId={data.id}
			transcriptionStatus={transcriptionStatus}
		>
			<PlaybackProvider
				videoRef={playerRef}
				stageRef={stageRef}
				fallbackDuration={data.duration}
			>
				{/*
				 * The page bar. It spans the video column AND the comments rail, so
				 * the rail hangs beneath it the way Loom's panel hangs beneath its
				 * top bar. Hidden (never unmounted) in timeline view, which carries
				 * its own slim title row: the header owns dialogs and the inline
				 * title editor, and toggling views must not discard them.
				 */}
				<div
					className={clsx(
						"shrink-0 border-b border-gray-5 bg-white px-4 lg:px-8",
						view === "timeline" && "hidden",
					)}
				>
					{header}
				</div>

				{/*
				 * The two-pane shell. On desktop the page itself no longer scrolls
				 * (see `page.tsx`): the video column scrolls inside the left pane and
				 * the comments rail runs the full height beside it.
				 * Phones stack the two and scroll the document as normal.
				 */}
				<div className="flex flex-col flex-1 min-h-0 lg:flex-row">
					<div className="flex flex-col flex-1 min-w-0 lg:overflow-y-auto">
						{/* Gutters live here rather than on the page, so the rail can sit
						    flush against the viewport edge while the video stays centred
						    inside what's left. */}
						<div className="flex flex-col flex-1 px-4 mx-auto w-full max-w-[80rem] lg:px-8">
							{/*
							 * Classic: a normal page section with bottom padding. Timeline: the
							 * card sizes itself to the video's aspect ratio (viewport-capped)
							 * and floats in the middle of the leftover viewport — the page above
							 * keeps this wrapper in a flex column, so flex-1 + justify-center is
							 * all the vertical centring takes. (Desktop only; small screens keep
							 * natural flow.)
							 */}
							<div
								className={clsx(
									view === "timeline"
										? "mt-2 pb-6 lg:mt-0 lg:pb-0 lg:flex lg:flex-1 lg:flex-col lg:justify-center"
										: "mt-4 pb-8",
								)}
							>
								{timelineAvailable && view === "timeline" && (
									// The top edge of the player card. It sits flush on the grid
									// below (which carries the bottom corners and the rest of the
									// border), so the two read as one contained, rounded unit,
									// centred at the same width. Classic view's toggle lives under
									// the player instead.
									<div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 rounded-t-xl border border-b-0 border-gray-5 bg-white px-5">
										<div className="flex min-w-0 items-center gap-3">
											<SignedImageUrl
												image={data.owner.image}
												name={data.owner.name ?? "Someone"}
												className="size-8 shrink-0 rounded-full"
												letterClass="text-xs font-medium"
											/>
											<div className="min-w-0">
												<p className="truncate text-sm font-medium leading-tight text-gray-12">
													{videoStatus?.name ?? data.name}
												</p>
												<p className="truncate text-xs leading-tight text-gray-10">
													{data.owner.name ?? "Someone"}
													{" · "}
													{formatTimeAgo(effectiveDate)}
												</p>
											</div>
										</div>
										<div className="flex shrink-0 items-center gap-2">
											{/* New surface, so it carries its own explainer. Opens in a
								    tab of its own: leaving the page would drop playback and
								    anything half-typed in the composer. */}
											<a
												href={TIMELINE_GUIDE_URL}
												target="_blank"
												rel="noreferrer"
												title="How does the timeline work?"
												className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-gray-5 bg-white px-2 text-xs font-medium text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 md:px-2.5"
											>
												<svg
													viewBox="0 0 16 16"
													className="size-3.5 shrink-0 fill-current"
													aria-hidden
												>
													<title>How does this work?</title>
													<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.2a5.3 5.3 0 1 1 0 10.6A5.3 5.3 0 0 1 8 2.7Zm0 1.6c-1.2 0-2.1.7-2.4 1.8a.6.6 0 0 0 1.15.34c.16-.55.6-.94 1.25-.94.7 0 1.2.44 1.2 1.03 0 .45-.2.73-.78 1.14-.66.47-.99.94-.96 1.72a.6.6 0 0 0 1.2-.04c-.02-.35.1-.53.53-.83.75-.53 1.21-1.08 1.21-2 0-1.25-1.02-2.22-2.4-2.22Zm0 6.05a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
												</svg>
												<span className="hidden md:inline">
													How does this work?
												</span>
											</a>
											<ShareViewToggle
												view={view}
												onChange={setViewAndUrl}
												// Fullscreen: a morph would rip the video out of the
												// fullscreen element. Recording: leaving the timeline
												// unmounts the recorder and silently discards the take.
												disabled={stageFullscreen || timelineRecording}
												prefetch={prefetchTimeline}
											/>
										</div>
									</div>
								)}

								{/*
								 * One grid, two arrangements. The stage below is a single JSX node
								 * at a single tree position in both views. Only its grid placement
								 * and its siblings change, because remounting it would tear down
								 * the media-chrome store inside the player and restart playback.
								 */}
								<div
									className={clsx(
										"grid relative",
										// In timeline view the grid is the body of the player card:
										// contained, centred, bottom corners rounded (the title row
										// above carries the top ones). Background clips to the radius
										// on its own, so no overflow-clip — the shelf's cards must
										// escape.
										view === "timeline"
											? "mx-auto w-full max-w-6xl gap-0 rounded-b-xl border border-t-0 border-gray-5 bg-white"
											: "gap-4",
										// One column in both views: the comments rail left the grid to
										// become a full-height pane beside it.
										"lg:grid-cols-1",
									)}
								>
									<motion.div
										ref={stageRef}
										layout
										data-morphing={morphing ? "" : undefined}
										onLayoutAnimationStart={() => setMorphing(true)}
										onLayoutAnimationComplete={() => setMorphing(false)}
										transition={
											reduceMotion
												? { duration: 0 }
												: {
														type: "spring",
														stiffness: 260,
														damping: 32,
														mass: 0.9,
													}
										}
										className={clsx(
											"min-w-0",
											// Contained card, not full-bleed: the unit keeps the page's
											// gutters and sits centred with everything else.
											view === "timeline"
												? "lg:col-span-full lg:row-start-1"
												: "lg:col-start-1 lg:row-start-1",
										)}
									>
										{/*
										 * Classic: a white page card holding the video. Timeline: the
										 * screen at the top of the card, edge to edge and squared off,
										 * with the light chrome (strip, comments, controls) below it.
										 */}
										<div
											className={clsx(
												"overflow-visible relative transition-[border-radius] duration-300",
												// Timeline: the screen, sized by the video's own aspect ratio
												// (style below), so a landscape recording meets the strip
												// with no bar of black under it. It stays dark — the screen
												// is the one part of the card that isn't chrome, same as the
												// black box classic view paints inside its white card. The
												// colour is the player's dark `--background` token spelled
												// out (a `dark` class here would restyle every overlay
												// inside the stage).
												// The 340px budget covers the card's own chrome (title row,
												// strip, shelf, bar) plus page margins, so the centred card
												// always fits the viewport — justify-center clips at the
												// top if its content overflows.
												// The 280px floor is desktop-only: on a phone it would beat
												// the aspect ratio and letterbox the video away from the
												// strip. The 65svh cap keeps a portrait video from pushing
												// the deck below the fold; the video pillarboxes inside.
												view === "timeline"
													? "rounded-none bg-[hsl(224,71.4%,4.1%)] w-full max-h-[65svh] lg:min-h-[280px] lg:max-h-[calc(100vh-340px)]"
													: "rounded-2xl border border-gray-5 bg-white aspect-video",
											)}
											style={
												view === "timeline"
													? { aspectRatio: String(stageAspect) }
													: undefined
											}
										>
											<div
												className={
													isScreenshot
														? "absolute inset-3 w-[calc(100%-1.5rem)] h-[calc(100%-1.5rem)] overflow-visible rounded-xl"
														: view === "timeline"
															? "absolute inset-0 overflow-visible"
															: "absolute inset-x-3 top-1/2 aspect-video -translate-y-1/2 overflow-visible rounded-xl"
												}
											>
												{isScreenshot ? (
													<ScreenshotImage
														src={screenshotImageUrl}
														alt={data.name}
													/>
												) : (
													<ShareVideo
														data={{ ...data, transcriptionStatus }}
														comments={comments}
														areChaptersDisabled={areChaptersDisabled}
														areCaptionsDisabled={areCaptionsDisabled}
														// The deck under the video owns seeking, the clock and
														// comments in timeline view; duplicating them inside the
														// video reads as two players. Fullscreen hides the deck,
														// so the in-video versions come back for its duration.
														externalTimeline={
															view === "timeline" && !stageFullscreen
														}
														controlsPortalEl={
															view === "timeline" && !stageFullscreen
																? controlsSlot
																: null
														}
														areCommentStampsDisabled={
															areCommentStampsDisabled ||
															(view === "timeline" && !stageFullscreen)
														}
														areReactionStampsDisabled={
															areReactionStampsDisabled ||
															(view === "timeline" && !stageFullscreen)
														}
														chapters={aiData?.chapters ?? undefined}
														aiGenerationStatus={aiData?.aiGenerationStatus}
														canRetryProcessing={viewerId === data.owner.id}
														canFinalizeDesktopSegments={
															viewerId === data.owner.id
														}
														showPlaybackStatusBadge={viewerId === data.owner.id}
														isEditProcessing={isEditProcessing}
														recordingStopped={recordingStopped}
														defaultPlaybackSpeed={defaultPlaybackSpeed}
														ref={playerRef}
													/>
												)}
											</div>
										</div>
									</motion.div>

									<AnimatePresence mode="popLayout" initial={false}>
										{view === "classic" ? (
											<motion.div
												key="toolbar"
												className="lg:col-span-full lg:row-start-2"
												initial={{ opacity: 0 }}
												animate={{ opacity: 1 }}
												exit={{ opacity: 0 }}
												transition={{ duration: reduceMotion ? 0 : 0.14 }}
											>
												{/*
												 * The view toggle sits to the left under the player; the
												 * absolute placement (desktop) keeps the toolbar pill
												 * centred rather than pushed aside.
												 */}
												<div className="relative">
													{timelineAvailable && (
														<div className="mb-3 flex justify-start lg:absolute lg:left-0 lg:top-1/2 lg:mb-0 lg:-translate-y-1/2">
															<ShareViewToggle
																view={view}
																onChange={setViewAndUrl}
																disabled={stageFullscreen || timelineRecording}
																prefetch={prefetchTimeline}
															/>
														</div>
													)}
													<Toolbar
														onOptimisticComment={handleOptimisticComment}
														onCommentSuccess={handleCommentSuccess}
														disableComments={areCommentStampsDisabled}
														disableReactions={areReactionStampsDisabled}
														data={data}
													/>
												</div>
											</motion.div>
										) : (
											// The band runs its own enter/exit; this wrapper only exists
											// to give popLayout a motion child to pop out of the grid.
											<motion.div
												key="timeline"
												className="lg:col-span-full lg:row-start-2"
											>
												<Suspense fallback={<TimelineSkeleton />}>
													<TimelineView
														comments={visibleComments}
														videoId={data.id}
														chapters={aiData?.chapters ?? undefined}
														transcriptionStatus={transcriptionStatus}
														filmstripSource={filmstripSource}
														onOptimisticComment={handleOptimisticComment}
														onCommentSuccess={handleCommentSuccess}
														canRecordMedia={canRecordMedia}
														viewerSignedIn={viewerSignedIn}
														disableReactions={areReactionStampsDisabled}
														onRecordingActiveChange={setTimelineRecording}
														onControlsSlotChange={setControlsSlot}
													/>
												</Suspense>
											</motion.div>
										)}
									</AnimatePresence>

									<AnimatePresence mode="popLayout" initial={false}>
										{view === "classic" && (
											<motion.div
												key="summary"
												className="hidden lg:block lg:col-span-full lg:row-start-3"
												initial={{ opacity: 0 }}
												animate={{ opacity: 1 }}
												exit={{ opacity: 0 }}
												transition={{ duration: reduceMotion ? 0 : 0.14 }}
											>
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
																		<div
																			key={i}
																			className="flex items-center p-2"
																		>
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
											</motion.div>
										)}
									</AnimatePresence>
								</div>
							</div>
						</div>
					</div>

					{/*
					 * The comments rail. Full height, flush to the viewport edge and
					 * scrolling independently of the video column — the panel is the
					 * one part of this page whose usefulness is measured in vertical
					 * space. Collapsing animates the width away; the pane stays mounted
					 * so the open tab and scroll position survive the round trip.
					 */}
					{showRail && (
						<aside
							className={clsx(
								"shrink-0 px-4 pb-8 lg:p-0 lg:h-full lg:border-l lg:border-gray-5 lg:bg-white lg:overflow-hidden",
								reduceMotion
									? undefined
									: "lg:transition-[width] lg:duration-300 lg:ease-out",
								railCollapsed ? "lg:w-0" : "lg:w-[22rem] xl:w-[24rem]",
							)}
						>
							{/* Hidden rather than merely clipped while collapsed, so the
						    panel's inputs leave the tab order. Scoped to lg: the
						    stored preference is a desktop one and the phone layout
						    shows the panel regardless. */}
							<div
								className={clsx(
									"lg:h-full lg:w-[22rem] xl:w-[24rem]",
									railCollapsed && "lg:invisible",
								)}
							>
								<Sidebar
									data={{
										...data,
										createdAt: effectiveDate,
										transcriptionStatus,
									}}
									videoSettings={videoSettings}
									commentsData={commentsData}
									setCommentsData={setCommentsData}
									optimisticComments={visibleComments}
									setOptimisticComments={setOptimisticComments}
									handleCommentSuccess={handleCommentSuccess}
									views={views}
									onSeek={isScreenshot ? undefined : handleSeek}
									isScreenshot={isScreenshot}
									videoId={data.id}
									aiData={aiData}
									aiGenerationEnabled={aiGenerationAvailable}
									recordingStopped={recordingStopped}
									canRecordMedia={canRecordMedia}
									onCollapse={toggleRail}
									ref={activityRef}
								/>
							</div>
						</aside>
					)}

					{/* Only handle back to the panel once it's away. Sits on the edge
					    it collapsed into, so the gesture reverses itself. */}
					{showRail && railCollapsed && (
						<button
							type="button"
							onClick={toggleRail}
							aria-label="Show comments"
							title="Show comments"
							className="hidden fixed right-0 top-1/2 z-30 items-center justify-center -translate-y-1/2 rounded-l-lg border border-r-0 border-gray-5 bg-white h-16 w-6 text-gray-10 shadow-sm transition-colors hover:text-gray-12 lg:flex"
						>
							<ChevronGlyph direction="left" />
						</button>
					)}
				</div>
			</PlaybackProvider>
		</CaptionProvider>
	);
};

function ChevronGlyph({ direction }: { direction: "left" | "right" }) {
	return (
		<svg
			viewBox="0 0 16 16"
			className={clsx(
				"size-4 fill-current",
				direction === "right" && "rotate-180",
			)}
			aria-hidden
		>
			<title>{direction === "left" ? "Expand" : "Collapse"}</title>
			<path d="M10.3 3.3a.6.6 0 0 1 0 .85L6.45 8l3.85 3.85a.6.6 0 1 1-.85.85l-4.27-4.27a.6.6 0 0 1 0-.86L9.45 3.3a.6.6 0 0 1 .85 0Z" />
		</svg>
	);
}

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
