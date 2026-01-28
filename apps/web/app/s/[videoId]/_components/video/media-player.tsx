"use client";

import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@cap/ui";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { Slot } from "@radix-ui/react-slot";
import {
	AlertTriangleIcon,
	CaptionsOffIcon,
	CheckIcon,
	DownloadIcon,
	FastForwardIcon,
	Loader2Icon,
	Maximize2Icon,
	Minimize2Icon,
	PauseIcon,
	PictureInPicture2Icon,
	PictureInPictureIcon,
	PlayIcon,
	RefreshCcwIcon,
	RepeatIcon,
	RewindIcon,
	RotateCcwIcon,
	SettingsIcon,
	SparklesIcon,
	SubtitlesIcon,
	Volume1Icon,
	Volume2Icon,
	VolumeXIcon,
} from "lucide-react";
import {
	MediaActionTypes,
	MediaProvider,
	timeUtils,
	useMediaDispatch,
	useMediaFullscreenRef,
	useMediaRef,
	useMediaSelector,
} from "media-chrome/react/media-store";
import * as React from "react";
import { forwardRef, useEffect } from "react";
import * as ReactDOM from "react-dom";
import { useComposedRefs } from "@/app/lib/compose-refs";
import { cn } from "@/app/lib/utils";
import { Badge } from "./badge";
import { Button as PlayerButton } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const ROOT_NAME = "MediaPlayer";
const SEEK_NAME = "MediaPlayerSeek";
const SETTINGS_NAME = "MediaPlayerSettings";
const VOLUME_NAME = "MediaPlayerVolume";
const PLAYBACK_SPEED_NAME = "MediaPlayerPlaybackSpeed";

const FLOATING_MENU_SIDE_OFFSET = 10;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const SEEK_STEP_SHORT = 5;
const SEEK_STEP_LONG = 10;
const SEEK_COLLISION_PADDING = 10;
const SEEK_TOOLTIP_WIDTH_FALLBACK = 240;

const SEEK_HOVER_PERCENT = "--seek-hover-percent";
const SEEK_TOOLTIP_X = "--seek-tooltip-x";
const SEEK_TOOLTIP_Y = "--seek-tooltip-y";

const SPRITE_CONTAINER_WIDTH = 224;
const SPRITE_CONTAINER_HEIGHT = 128;

type Direction = "ltr" | "rtl";

const DirectionContext = React.createContext<Direction | undefined>(undefined);

function useDirection(dirProp?: Direction): Direction {
	const contextDir = React.useContext(DirectionContext);
	return dirProp ?? contextDir ?? "ltr";
}

function useLazyRef<T>(fn: () => T) {
	const ref = React.useRef<T | null>(null);

	if (ref.current === null) {
		ref.current = fn();
	}

	return ref as React.RefObject<T>;
}

interface StoreState {
	controlsVisible: boolean;
	dragging: boolean;
	menuOpen: boolean;
	volumeIndicatorVisible: boolean;
}

interface Store {
	subscribe: (cb: () => void) => () => void;
	getState: () => StoreState;
	setState: (
		key: keyof StoreState,
		value: StoreState[keyof StoreState],
	) => void;
	notify: () => void;
}

function createStore(
	listenersRef: React.RefObject<Set<() => void>>,
	stateRef: React.RefObject<StoreState>,
	onValueChange?: Partial<{
		[K in keyof StoreState]: (value: StoreState[K], store: Store) => void;
	}>,
): Store {
	const store: Store = {
		subscribe: (cb) => {
			listenersRef.current?.add(cb);
			return () => listenersRef.current?.delete(cb);
		},
		getState: () => stateRef.current!,
		setState: (key, value) => {
			if (Object.is(stateRef.current?.[key], value)) return;
			stateRef.current![key] = value;
			onValueChange?.[key]?.(value, store);
			store.notify();
		},
		notify: () => {
			for (const cb of listenersRef.current ?? []) {
				cb();
			}
		},
	};

	return store;
}

const StoreContext = React.createContext<Store | null>(null);

function useStoreContext(consumerName: string) {
	const context = React.useContext(StoreContext);
	if (!context) {
		throw new Error(`\`${consumerName}\` must be used within \`${ROOT_NAME}\``);
	}
	return context;
}

function useStoreSelector<U>(selector: (state: StoreState) => U): U {
	const storeContext = useStoreContext("useStoreSelector");

	const getSnapshot = React.useCallback(
		() => selector(storeContext.getState()),
		[storeContext, selector],
	);

	return React.useSyncExternalStore(
		storeContext.subscribe,
		getSnapshot,
		getSnapshot,
	);
}

interface MediaPlayerContextValue {
	mediaId: string;
	labelId: string;
	descriptionId: string;
	dir: Direction;
	rootRef: React.RefObject<HTMLDivElement | null>;
	mediaRef: React.RefObject<HTMLVideoElement | HTMLAudioElement | null>;
	portalContainer: Element | DocumentFragment | null;
	tooltipDelayDuration: number;
	tooltipSideOffset: number;
	disabled: boolean;
	isVideo: boolean;
	withoutTooltip: boolean;
}

const MediaPlayerContext = React.createContext<MediaPlayerContextValue | null>(
	null,
);

function useMediaPlayerContext(consumerName: string) {
	const context = React.useContext(MediaPlayerContext);
	if (!context) {
		throw new Error(`\`${consumerName}\` must be used within \`${ROOT_NAME}\``);
	}
	return context;
}

interface MediaPlayerRootProps
	extends Omit<React.ComponentProps<"div">, "onTimeUpdate" | "onVolumeChange"> {
	onPlay?: () => void;
	onPause?: () => void;
	onEnded?: () => void;
	onTimeUpdate?: (time: number) => void;
	onVolumeChange?: (volume: number) => void;
	onMuted?: (muted: boolean) => void;
	onMediaError?: (error: MediaError | null) => void;
	onPipError?: (error: unknown, state: "enter" | "exit") => void;
	onFullscreenChange?: (fullscreen: boolean) => void;
	dir?: Direction;
	label?: string;
	tooltipDelayDuration?: number;
	tooltipSideOffset?: number;
	asChild?: boolean;
	autoHide?: boolean;
	disabled?: boolean;
	withoutTooltip?: boolean;
}

function MediaPlayerRoot(props: MediaPlayerRootProps) {
	const listenersRef = useLazyRef(() => new Set<() => void>());
	const stateRef = useLazyRef<StoreState>(() => ({
		controlsVisible: true,
		dragging: false,
		menuOpen: false,
		volumeIndicatorVisible: false,
	}));

	const store = React.useMemo(
		() => createStore(listenersRef, stateRef),
		[listenersRef, stateRef],
	);

	return (
		<MediaProvider>
			<StoreContext.Provider value={store}>
				<MediaPlayerRootImpl {...props} />
			</StoreContext.Provider>
		</MediaProvider>
	);
}

function MediaPlayerRootImpl(props: MediaPlayerRootProps) {
	const {
		onPlay,
		onPause,
		onEnded,
		onTimeUpdate,
		onFullscreenChange,
		onVolumeChange,
		onMuted,
		onMediaError,
		onPipError,
		dir: dirProp,
		label,
		tooltipDelayDuration = 600,
		tooltipSideOffset = FLOATING_MENU_SIDE_OFFSET,
		asChild,
		autoHide = false,
		disabled = false,
		withoutTooltip = false,
		children,
		className,
		ref,
		...rootImplProps
	} = props;

	const mediaId = React.useId();
	const labelId = React.useId();
	const descriptionId = React.useId();

	const rootRef = React.useRef<HTMLDivElement | null>(null);
	const fullscreenRef = useMediaFullscreenRef();
	const composedRef = useComposedRefs(ref, rootRef, fullscreenRef);

	const dir = useDirection(dirProp);
	const dispatch = useMediaDispatch();
	const mediaRef = React.useRef<HTMLVideoElement | HTMLAudioElement | null>(
		null,
	);

	const store = useStoreContext(ROOT_NAME);

	const controlsVisible = useStoreSelector((state) => state.controlsVisible);
	const dragging = useStoreSelector((state) => state.dragging);
	const menuOpen = useStoreSelector((state) => state.menuOpen);

	const hideControlsTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
	const lastMouseMoveRef = React.useRef<number>(Date.now());
	const volumeIndicatorTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

	const mediaPaused = useMediaSelector((state) => state.mediaPaused ?? true);
	const isFullscreen = useMediaSelector(
		(state) => state.mediaIsFullscreen ?? false,
	);

	const [mounted, setMounted] = React.useState(false);
	React.useLayoutEffect(() => setMounted(true), []);

	const portalContainer = mounted
		? isFullscreen
			? rootRef.current
			: globalThis.document.body
		: null;

	const isVideo =
		(typeof HTMLVideoElement !== "undefined" &&
			mediaRef.current instanceof HTMLVideoElement) ||
		mediaRef.current?.tagName?.toLowerCase() === "mux-player";

	const onControlsShow = React.useCallback(() => {
		store.setState("controlsVisible", true);
		lastMouseMoveRef.current = Date.now();

		if (hideControlsTimeoutRef.current) {
			clearTimeout(hideControlsTimeoutRef.current);
		}

		if (autoHide && !mediaPaused && !menuOpen && !dragging) {
			hideControlsTimeoutRef.current = setTimeout(() => {
				store.setState("controlsVisible", false);
			}, 3000);
		}
	}, [store.setState, autoHide, mediaPaused, menuOpen, dragging]);

	const onVolumeIndicatorTrigger = React.useCallback(() => {
		if (menuOpen) return;

		store.setState("volumeIndicatorVisible", true);

		if (volumeIndicatorTimeoutRef.current) {
			clearTimeout(volumeIndicatorTimeoutRef.current);
		}

		volumeIndicatorTimeoutRef.current = setTimeout(() => {
			store.setState("volumeIndicatorVisible", false);
		}, 2000);

		if (autoHide) {
			onControlsShow();
		}
	}, [store.setState, menuOpen, autoHide, onControlsShow]);

	const onMouseLeave = React.useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			rootImplProps.onMouseLeave?.(event);

			if (event.defaultPrevented) return;

			if (autoHide && !mediaPaused && !menuOpen && !dragging) {
				store.setState("controlsVisible", false);
			}
		},
		[
			store.setState,
			rootImplProps.onMouseLeave,
			autoHide,
			mediaPaused,
			menuOpen,
			dragging,
		],
	);

	const onMouseMove = React.useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			rootImplProps.onMouseMove?.(event);

			if (event.defaultPrevented) return;

			if (autoHide) {
				onControlsShow();
			}
		},
		[autoHide, rootImplProps.onMouseMove, onControlsShow],
	);

	React.useEffect(() => {
		if (mediaPaused || menuOpen || dragging) {
			store.setState("controlsVisible", true);
			if (hideControlsTimeoutRef.current) {
				clearTimeout(hideControlsTimeoutRef.current);
			}
			return;
		}

		if (autoHide) {
			onControlsShow();
		}
	}, [
		store.setState,
		onControlsShow,
		autoHide,
		menuOpen,
		mediaPaused,
		dragging,
	]);

	const onKeyDown = React.useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (disabled) return;

			rootImplProps.onKeyDown?.(event);

			if (event.defaultPrevented) return;

			const mediaElement = mediaRef.current;
			if (!mediaElement) return;

			const isMediaFocused = document.activeElement === mediaElement;
			const isPlayerFocused =
				document.activeElement?.closest('[data-slot="media-player"]') !== null;

			if (!isMediaFocused && !isPlayerFocused) return;

			if (autoHide) onControlsShow();

			switch (event.key.toLowerCase()) {
				case " ":
				case "k":
					event.preventDefault();
					dispatch({
						type: mediaElement.paused
							? MediaActionTypes.MEDIA_PLAY_REQUEST
							: MediaActionTypes.MEDIA_PAUSE_REQUEST,
					});
					break;

				case "f":
					event.preventDefault();
					dispatch({
						type: document.fullscreenElement
							? MediaActionTypes.MEDIA_EXIT_FULLSCREEN_REQUEST
							: MediaActionTypes.MEDIA_ENTER_FULLSCREEN_REQUEST,
					});
					break;

				case "m": {
					event.preventDefault();
					if (isVideo) {
						onVolumeIndicatorTrigger();
					}
					dispatch({
						type: mediaElement.muted
							? MediaActionTypes.MEDIA_UNMUTE_REQUEST
							: MediaActionTypes.MEDIA_MUTE_REQUEST,
					});
					break;
				}

				case "arrowright":
					event.preventDefault();
					if (
						isVideo ||
						(mediaElement instanceof HTMLAudioElement && event.shiftKey)
					) {
						dispatch({
							type: MediaActionTypes.MEDIA_SEEK_REQUEST,
							detail: Math.min(
								mediaElement.duration,
								mediaElement.currentTime + SEEK_STEP_SHORT,
							),
						});
					}
					break;

				case "arrowleft":
					event.preventDefault();
					if (
						isVideo ||
						(mediaElement instanceof HTMLAudioElement && event.shiftKey)
					) {
						dispatch({
							type: MediaActionTypes.MEDIA_SEEK_REQUEST,
							detail: Math.max(0, mediaElement.currentTime - SEEK_STEP_SHORT),
						});
					}
					break;

				case "arrowup":
					event.preventDefault();
					if (isVideo) {
						onVolumeIndicatorTrigger();
						dispatch({
							type: MediaActionTypes.MEDIA_VOLUME_REQUEST,
							detail: Math.min(1, mediaElement.volume + 0.1),
						});
					}
					break;

				case "arrowdown":
					event.preventDefault();
					if (isVideo) {
						onVolumeIndicatorTrigger();
						dispatch({
							type: MediaActionTypes.MEDIA_VOLUME_REQUEST,
							detail: Math.max(0, mediaElement.volume - 0.1),
						});
					}
					break;

				case "<": {
					event.preventDefault();
					const currentRate = mediaElement.playbackRate;
					const currentIndex = SPEEDS.indexOf(currentRate);
					const newIndex = Math.max(0, currentIndex - 1);
					const newRate = SPEEDS[newIndex] ?? 1;
					dispatch({
						type: MediaActionTypes.MEDIA_PLAYBACK_RATE_REQUEST,
						detail: newRate,
					});
					break;
				}

				case ">": {
					event.preventDefault();
					const currentRate = mediaElement.playbackRate;
					const currentIndex = SPEEDS.indexOf(currentRate);
					const newIndex = Math.min(SPEEDS.length - 1, currentIndex + 1);
					const newRate = SPEEDS[newIndex] ?? 1;
					dispatch({
						type: MediaActionTypes.MEDIA_PLAYBACK_RATE_REQUEST,
						detail: newRate,
					});
					break;
				}

				// case "c":
				//   event.preventDefault();
				//   if (isVideo && mediaElement.textTracks.length > 0) {
				//     dispatch({
				//       type: MediaActionTypes.MEDIA_TOGGLE_SUBTITLES_REQUEST,
				//     });
				//   }
				//   break;

				case "d": {
					const hasDownload = mediaElement.querySelector(
						'[data-slot="media-player-download"]',
					);

					if (!hasDownload) break;

					event.preventDefault();
					if (mediaElement.currentSrc) {
						const link = document.createElement("a");
						link.href = mediaElement.currentSrc;
						link.download = "";
						document.body.appendChild(link);
						link.click();
						document.body.removeChild(link);
					}
					break;
				}

				case "p": {
					event.preventDefault();
					if (isVideo && "requestPictureInPicture" in mediaElement) {
						const isPip = document.pictureInPictureElement === mediaElement;
						dispatch({
							type: isPip
								? MediaActionTypes.MEDIA_EXIT_PIP_REQUEST
								: MediaActionTypes.MEDIA_ENTER_PIP_REQUEST,
						});
						if (isPip) {
							document.exitPictureInPicture().catch((error) => {
								onPipError?.(error, "exit");
							});
						} else {
							mediaElement.requestPictureInPicture().catch((error) => {
								onPipError?.(error, "enter");
							});
						}
					}
					break;
				}

				case "r": {
					event.preventDefault();
					mediaElement.loop = !mediaElement.loop;
					break;
				}

				case "j": {
					event.preventDefault();
					dispatch({
						type: MediaActionTypes.MEDIA_SEEK_REQUEST,
						detail: Math.max(0, mediaElement.currentTime - SEEK_STEP_LONG),
					});
					break;
				}

				case "l": {
					event.preventDefault();
					dispatch({
						type: MediaActionTypes.MEDIA_SEEK_REQUEST,
						detail: Math.min(
							mediaElement.duration,
							mediaElement.currentTime + SEEK_STEP_LONG,
						),
					});
					break;
				}

				case "0":
				case "1":
				case "2":
				case "3":
				case "4":
				case "5":
				case "6":
				case "7":
				case "8":
				case "9": {
					event.preventDefault();
					const percent = Number.parseInt(event.key, 10) / 10;
					const seekTime = mediaElement.duration * percent;
					dispatch({
						type: MediaActionTypes.MEDIA_SEEK_REQUEST,
						detail: seekTime,
					});
					break;
				}

				case "home": {
					event.preventDefault();
					dispatch({
						type: MediaActionTypes.MEDIA_SEEK_REQUEST,
						detail: 0,
					});
					break;
				}

				case "end": {
					event.preventDefault();
					dispatch({
						type: MediaActionTypes.MEDIA_SEEK_REQUEST,
						detail: mediaElement.duration,
					});
					break;
				}
			}
		},
		[
			dispatch,
			rootImplProps.onKeyDown,
			onVolumeIndicatorTrigger,
			onPipError,
			disabled,
			isVideo,
			onControlsShow,
			autoHide,
		],
	);

	const onKeyUp = React.useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			rootImplProps.onKeyUp?.(event);

			const key = event.key.toLowerCase();
			if (key === "arrowup" || key === "arrowdown" || key === "m") {
				onVolumeIndicatorTrigger();
			}
		},
		[rootImplProps.onKeyUp, onVolumeIndicatorTrigger],
	);

	React.useEffect(() => {
		const mediaElement = mediaRef.current;
		if (!mediaElement) return;

		if (onPlay) mediaElement.addEventListener("play", onPlay);
		if (onPause) mediaElement.addEventListener("pause", onPause);
		if (onEnded) mediaElement.addEventListener("ended", onEnded);
		if (onTimeUpdate)
			mediaElement.addEventListener("timeupdate", () =>
				onTimeUpdate?.(mediaElement.currentTime),
			);
		if (onVolumeChange)
			mediaElement.addEventListener("volumechange", () => {
				onVolumeChange?.(mediaElement.volume);
				onMuted?.(mediaElement.muted);
			});
		if (onMediaError)
			mediaElement.addEventListener("error", () =>
				onMediaError?.(mediaElement.error),
			);
		if (onFullscreenChange) {
			document.addEventListener("fullscreenchange", () =>
				onFullscreenChange?.(!!document.fullscreenElement),
			);
		}

		return () => {
			if (onPlay) mediaElement.removeEventListener("play", onPlay);
			if (onPause) mediaElement.removeEventListener("pause", onPause);
			if (onEnded) mediaElement.removeEventListener("ended", onEnded);
			if (onTimeUpdate)
				mediaElement.removeEventListener("timeupdate", () =>
					onTimeUpdate?.(mediaElement.currentTime),
				);
			if (onVolumeChange)
				mediaElement.removeEventListener("volumechange", () => {
					onVolumeChange?.(mediaElement.volume);
					onMuted?.(mediaElement.muted);
				});
			if (onMediaError)
				mediaElement.removeEventListener("error", () =>
					onMediaError?.(mediaElement.error),
				);
			if (onFullscreenChange) {
				document.removeEventListener("fullscreenchange", () =>
					onFullscreenChange?.(!!document.fullscreenElement),
				);
			}
			if (volumeIndicatorTimeoutRef.current) {
				clearTimeout(volumeIndicatorTimeoutRef.current);
			}
			if (hideControlsTimeoutRef.current) {
				clearTimeout(hideControlsTimeoutRef.current);
			}
		};
	}, [
		onPlay,
		onPause,
		onEnded,
		onTimeUpdate,
		onVolumeChange,
		onMuted,
		onMediaError,
		onFullscreenChange,
	]);

	const contextValue = React.useMemo<MediaPlayerContextValue>(
		() => ({
			mediaId,
			labelId,
			descriptionId,
			dir,
			rootRef,
			mediaRef,
			portalContainer,
			tooltipDelayDuration,
			tooltipSideOffset,
			disabled,
			isVideo,
			withoutTooltip,
		}),
		[
			mediaId,
			labelId,
			descriptionId,
			dir,
			portalContainer,
			tooltipDelayDuration,
			tooltipSideOffset,
			disabled,
			isVideo,
			withoutTooltip,
		],
	);

	const RootPrimitive = asChild ? Slot : "div";

	return (
		<MediaPlayerContext.Provider value={contextValue}>
			<RootPrimitive
				aria-labelledby={labelId}
				aria-describedby={descriptionId}
				aria-disabled={disabled}
				data-disabled={disabled ? "" : undefined}
				data-controls-visible={controlsVisible ? "" : undefined}
				data-slot="media-player"
				data-state={isFullscreen ? "fullscreen" : "windowed"}
				dir={dir}
				tabIndex={disabled ? undefined : 0}
				{...rootImplProps}
				ref={composedRef}
				onMouseLeave={onMouseLeave}
				onMouseMove={onMouseMove}
				onKeyDown={onKeyDown}
				onKeyUp={onKeyUp}
				className={cn(
					"dark relative isolate flex flex-col overflow-visible bg-background outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_video]:relative [&_video]:object-contain",
					"data-[state=fullscreen]:[&_video]:size-full [:fullscreen_&]:flex [:fullscreen_&]:h-full [:fullscreen_&]:max-h-screen [:fullscreen_&]:flex-col [:fullscreen_&]:justify-between",
					"[&_[data-slider]::before]:-top-4 [&_[data-slider]::before]:-bottom-2 [&_[data-slider]::before]:absolute [&_[data-slider]::before]:inset-x-0 [&_[data-slider]::before]:z-10 [&_[data-slider]::before]:h-8 [&_[data-slider]::before]:cursor-pointer [&_[data-slider]::before]:content-[''] [&_[data-slider]]:relative [&_[data-slot='media-player-seek']:not([data-hovering])::before]:cursor-default",
					"[&_video::-webkit-media-text-track-display]:top-auto! [&_video::-webkit-media-text-track-display]:bottom-[4%]! [&_video::-webkit-media-text-track-display]:mb-0! data-[state=fullscreen]:data-[controls-visible]:[&_video::-webkit-media-text-track-display]:bottom-[9%]! data-[controls-visible]:[&_video::-webkit-media-text-track-display]:bottom-[13%]! data-[state=fullscreen]:[&_video::-webkit-media-text-track-display]:bottom-[7%]!",
					className,
				)}
			>
				<span id={labelId} className="sr-only">
					{label ?? "Media player"}
				</span>
				<span id={descriptionId} className="sr-only">
					{isVideo
						? "Video player with custom controls for playback, volume, seeking, and more. Use space bar to play/pause, arrow keys (←/→) to seek, and arrow keys (↑/↓) to adjust volume."
						: "Audio player with custom controls for playback, volume, seeking, and more. Use space bar to play/pause, Shift + arrow keys (←/→) to seek, and arrow keys (↑/↓) to adjust volume."}
				</span>
				{children}
				<MediaPlayerVolumeIndicator />
			</RootPrimitive>
		</MediaPlayerContext.Provider>
	);
}

interface MediaPlayerVideoProps extends React.ComponentProps<"video"> {
	asChild?: boolean;
}

const MediaPlayerVideo = forwardRef<HTMLVideoElement, MediaPlayerVideoProps>(
	(props: MediaPlayerVideoProps, ref) => {
		const { asChild, ...videoProps } = props;

		const context = useMediaPlayerContext("MediaPlayerVideo");
		const dispatch = useMediaDispatch();
		const mediaRefCallback = useMediaRef();
		const composedRef = useComposedRefs(
			ref,
			context.mediaRef,
			mediaRefCallback,
		);

		const onPlayToggle = React.useCallback(
			(event: React.MouseEvent<HTMLVideoElement>) => {
				props.onClick?.(event);

				if (event.defaultPrevented) return;

				const mediaElement = event.currentTarget;
				if (!mediaElement) return;

				dispatch({
					type: mediaElement.paused
						? MediaActionTypes.MEDIA_PLAY_REQUEST
						: MediaActionTypes.MEDIA_PAUSE_REQUEST,
				});
			},
			[dispatch, props.onClick],
		);

		const onContextMenu = React.useCallback(
			(event: React.MouseEvent<HTMLVideoElement>) => {
				event.preventDefault();
				props.onContextMenu?.(event);
			},
			[props.onContextMenu],
		);

		const VideoPrimitive = asChild ? Slot : "video";

		return (
			<VideoPrimitive
				aria-describedby={context.descriptionId}
				aria-labelledby={context.labelId}
				data-slot="media-player-video"
				{...videoProps}
				id={context.mediaId}
				ref={composedRef}
				onClick={onPlayToggle}
				onContextMenu={onContextMenu}
			/>
		);
	},
);

interface MediaPlayerAudioProps extends React.ComponentProps<"audio"> {
	asChild?: boolean;
}

function MediaPlayerAudio(props: MediaPlayerAudioProps) {
	const { asChild, ref, ...audioProps } = props;

	const context = useMediaPlayerContext("MediaPlayerAudio");
	const mediaRefCallback = useMediaRef();
	const composedRef = useComposedRefs(ref, context.mediaRef, mediaRefCallback);

	const AudioPrimitive = asChild ? Slot : "audio";

	return (
		<AudioPrimitive
			aria-describedby={context.descriptionId}
			aria-labelledby={context.labelId}
			data-slot="media-player-audio"
			{...audioProps}
			id={context.mediaId}
			ref={composedRef}
		/>
	);
}

interface MediaPlayerControlsProps extends React.ComponentProps<"div"> {
	asChild?: boolean;
	isUploadingOrFailed?: boolean;
	mainControlsVisible?: (arg: boolean) => void;
}

function MediaPlayerControls(props: MediaPlayerControlsProps) {
	const {
		asChild,
		className,
		isUploadingOrFailed,
		mainControlsVisible,
		...controlsProps
	} = props;

	const context = useMediaPlayerContext("MediaPlayerControls");
	const isFullscreen = useMediaSelector(
		(state) => state.mediaIsFullscreen ?? false,
	);
	const controlsVisible = useStoreSelector((state) => state.controlsVisible);
	// Call the callback whenever controlsVisible changes
	useEffect(() => {
		if (typeof mainControlsVisible === "function") {
			mainControlsVisible(controlsVisible);
		}
	}, [mainControlsVisible, controlsVisible]);

	const ControlsPrimitive = asChild ? Slot : "div";

	if (isUploadingOrFailed) return null;

	return (
		<ControlsPrimitive
			data-disabled={context.disabled ? "" : undefined}
			data-slot="media-player-controls"
			data-state={isFullscreen ? "fullscreen" : "windowed"}
			data-visible={controlsVisible ? "" : undefined}
			dir={context.dir}
			className={cn(
				"dark pointer-events-none absolute right-0 bottom-0 left-0 z-50 flex items-center gap-2 px-4 py-3 opacity-0 transition-opacity duration-200 data-[visible]:pointer-events-auto data-[visible]:opacity-100 [:fullscreen_&]:px-6 [:fullscreen_&]:py-4",
				className,
			)}
			{...controlsProps}
		/>
	);
}

interface MediaPlayerLoadingProps extends React.ComponentProps<"div"> {
	delayMs?: number;
	asChild?: boolean;
}

function MediaPlayerLoading(props: MediaPlayerLoadingProps) {
	const {
		delayMs = 500,
		asChild,
		className,
		children,
		...loadingProps
	} = props;

	const isLoading = useMediaSelector((state) => state.mediaLoading ?? false);
	const isPaused = useMediaSelector((state) => state.mediaPaused ?? true);
	const hasPlayed = useMediaSelector((state) => state.mediaHasPlayed ?? false);

	const shouldShowLoading = isLoading && !isPaused;
	const shouldUseDelay = hasPlayed && shouldShowLoading;
	const loadingDelayMs = shouldUseDelay ? delayMs : 0;

	const [shouldRender, setShouldRender] = React.useState(false);
	const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);

	React.useEffect(() => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}

		if (shouldShowLoading) {
			if (loadingDelayMs > 0) {
				timeoutRef.current = setTimeout(() => {
					setShouldRender(true);
					timeoutRef.current = null;
				}, loadingDelayMs);
			} else {
				setShouldRender(true);
			}
		} else {
			setShouldRender(false);
		}

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
			}
		};
	}, [shouldShowLoading, loadingDelayMs]);

	if (!shouldRender) return null;

	const LoadingPrimitive = asChild ? Slot : "div";

	return (
		<LoadingPrimitive
			role="status"
			aria-live="polite"
			data-slot="media-player-loading"
			{...loadingProps}
			className={cn(
				"flex absolute inset-0 z-50 justify-center items-center duration-200 pointer-events-none fade-in-0 zoom-in-95 animate-in",
				className,
			)}
		>
			<Loader2Icon className="size-20 animate-spin stroke-[.0938rem] text-white" />
		</LoadingPrimitive>
	);
}

interface MediaPlayerErrorProps extends React.ComponentProps<"div"> {
	error?: MediaError | null;
	label?: string;
	description?: string;
	onRetry?: () => void;
	onReload?: () => void;
	asChild?: boolean;
}

function MediaPlayerError(props: MediaPlayerErrorProps) {
	const {
		error: errorProp,
		label,
		description,
		onRetry: onRetryProp,
		onReload: onReloadProp,
		asChild,
		className,
		children,
		...errorProps
	} = props;

	const context = useMediaPlayerContext("MediaPlayerError");
	const isFullscreen = useMediaSelector(
		(state) => state.mediaIsFullscreen ?? false,
	);
	const mediaError = useMediaSelector((state) => state.mediaError);

	const error = errorProp ?? mediaError;

	const labelId = React.useId();
	const descriptionId = React.useId();

	const [actionState, setActionState] = React.useState<{
		retryPending: boolean;
		reloadPending: boolean;
	}>({
		retryPending: false,
		reloadPending: false,
	});

	const onRetry = React.useCallback(() => {
		setActionState((prev) => ({ ...prev, retryPending: true }));

		requestAnimationFrame(() => {
			const mediaElement = context.mediaRef.current;
			if (!mediaElement) {
				setActionState((prev) => ({ ...prev, retryPending: false }));
				return;
			}

			if (onRetryProp) {
				onRetryProp();
			} else {
				const currentSrc = mediaElement.currentSrc ?? mediaElement.src;
				if (currentSrc) {
					mediaElement.load();
				}
			}

			setActionState((prev) => ({ ...prev, retryPending: false }));
		});
	}, [context.mediaRef, onRetryProp]);

	const onReload = React.useCallback(() => {
		setActionState((prev) => ({ ...prev, reloadPending: true }));

		requestAnimationFrame(() => {
			if (onReloadProp) {
				onReloadProp();
			} else {
				window.location.reload();
			}
		});
	}, [onReloadProp]);

	const errorLabel = React.useMemo(() => {
		if (label) return label;

		if (!error) return "Playback Error";

		const labelMap: Record<number, string> = {
			[MediaError.MEDIA_ERR_ABORTED]: "Playback Interrupted",
			[MediaError.MEDIA_ERR_NETWORK]: "Connection Problem",
			[MediaError.MEDIA_ERR_DECODE]: "Media Error",
			[MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: "Unsupported Format",
		};

		return labelMap[error.code] ?? "Playback Error";
	}, [label, error]);

	const errorDescription = React.useMemo(() => {
		if (description) return description;

		if (!error) return "An unknown error occurred";

		const descriptionMap: Record<number, string> = {
			[MediaError.MEDIA_ERR_ABORTED]: "Media playback was aborted",
			[MediaError.MEDIA_ERR_NETWORK]:
				"A network error occurred while loading the media",
			[MediaError.MEDIA_ERR_DECODE]:
				"An error occurred while decoding the media",
			[MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]:
				"The media format is not supported",
		};

		return descriptionMap[error.code] ?? "An unknown error occurred";
	}, [description, error]);

	if (!error) return null;

	const ErrorPrimitive = asChild ? Slot : "div";

	return (
		<ErrorPrimitive
			role="alert"
			aria-describedby={descriptionId}
			aria-labelledby={labelId}
			aria-live="assertive"
			data-slot="media-player-error"
			data-state={isFullscreen ? "fullscreen" : "windowed"}
			{...errorProps}
			className={cn(
				"flex absolute inset-0 z-50 flex-col justify-center items-center text-white backdrop-blur-sm pointer-events-auto bg-black/80",
				className,
			)}
		>
			{children ?? (
				<div className="flex flex-col gap-4 items-center px-6 py-8 max-w-md text-center">
					<AlertTriangleIcon className="text-red-500 size-12" />
					<div className="flex flex-col gap-px text-center">
						<h3 className="text-xl font-semibold tracking-tight">
							{errorLabel}
						</h3>
						<p className="text-sm leading-relaxed text-balance text-gray-11">
							{errorDescription}
						</p>
					</div>
					<div className="flex gap-2 items-center">
						<Button
							variant="primary"
							size="sm"
							onClick={onRetry}
							disabled={actionState.retryPending}
						>
							{actionState.retryPending ? (
								<Loader2Icon className="animate-spin size-3.5" />
							) : (
								<RefreshCcwIcon className="size-3.5" />
							)}
							Try again
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={onReload}
							disabled={actionState.reloadPending}
						>
							{actionState.reloadPending ? (
								<Loader2Icon className="animate-spin size-3.5" />
							) : (
								<RotateCcwIcon className="size-3.5" />
							)}
							Reload page
						</Button>
					</div>
				</div>
			)}
		</ErrorPrimitive>
	);
}

interface MediaPlayerVolumeIndicatorProps extends React.ComponentProps<"div"> {
	asChild?: boolean;
}

function MediaPlayerVolumeIndicator(props: MediaPlayerVolumeIndicatorProps) {
	const { asChild, className, ...indicatorProps } = props;

	const mediaVolume = useMediaSelector((state) => state.mediaVolume ?? 1);
	const mediaMuted = useMediaSelector((state) => state.mediaMuted ?? false);
	const mediaVolumeLevel = useMediaSelector(
		(state) => state.mediaVolumeLevel ?? "high",
	);
	const volumeIndicatorVisible = useStoreSelector(
		(state) => state.volumeIndicatorVisible,
	);

	if (!volumeIndicatorVisible) return null;

	const effectiveVolume = mediaMuted ? 0 : mediaVolume;
	const volumePercentage = Math.round(effectiveVolume * 100);
	const barCount = 10;
	const activeBarCount = Math.ceil(effectiveVolume * barCount);

	const VolumeIndicatorPrimitive = asChild ? Slot : "div";

	return (
		<VolumeIndicatorPrimitive
			role="status"
			aria-live="polite"
			aria-label={`Volume ${mediaMuted ? "muted" : `${volumePercentage}%`}`}
			data-slot="media-player-volume-indicator"
			{...indicatorProps}
			className={cn(
				"flex absolute inset-0 z-50 justify-center items-center pointer-events-none",
				className,
			)}
		>
			<div className="flex flex-col gap-3 items-center px-6 py-4 text-white rounded-lg duration-200 fade-in-0 zoom-in-95 animate-in bg-black/30 backdrop-blur-xs">
				<div className="flex gap-2 items-center">
					{mediaVolumeLevel === "off" || mediaMuted ? (
						<VolumeXIcon className="size-6" />
					) : mediaVolumeLevel === "high" ? (
						<Volume2Icon className="size-6" />
					) : (
						<Volume1Icon className="size-6" />
					)}
					<span className="text-sm font-medium tabular-nums">
						{mediaMuted ? "Muted" : `${volumePercentage}%`}
					</span>
				</div>
				<div className="flex gap-1 items-center">
					{Array.from({ length: barCount }, (_, index) => (
						<div
							key={index}
							className={cn(
								"w-1.5 rounded-full transition-all duration-150",
								index < activeBarCount && !mediaMuted
									? "scale-100 bg-white"
									: "scale-90 bg-white/30",
							)}
							style={{
								height: `${12 + index * 2}px`,
								animationDelay: `${index * 50}ms`,
							}}
						/>
					))}
				</div>
			</div>
		</VolumeIndicatorPrimitive>
	);
}

interface MediaPlayerControlsOverlayProps extends React.ComponentProps<"div"> {
	asChild?: boolean;
}

function MediaPlayerControlsOverlay(props: MediaPlayerControlsOverlayProps) {
	const { asChild, className, ...overlayProps } = props;

	const isFullscreen = useMediaSelector(
		(state) => state.mediaIsFullscreen ?? false,
	);
	const controlsVisible = useStoreSelector((state) => state.controlsVisible);

	const OverlayPrimitive = asChild ? Slot : "div";

	return (
		<OverlayPrimitive
			data-slot="media-player-controls-overlay"
			data-state={isFullscreen ? "fullscreen" : "windowed"}
			data-visible={controlsVisible ? "" : undefined}
			{...overlayProps}
			className={cn(
				"absolute inset-0 bg-gradient-to-t to-transparent opacity-0 transition-opacity duration-200 pointer-events-none -z-10 from-black/80 data-[visible]:opacity-100",
				className,
			)}
		/>
	);
}

interface MediaPlayerPlayProps extends React.ComponentProps<typeof Button> {}

function MediaPlayerPlay(props: MediaPlayerPlayProps) {
	const { asChild, children, className, disabled, ...playButtonProps } = props;

	const context = useMediaPlayerContext("MediaPlayerPlay");
	const dispatch = useMediaDispatch();
	const mediaPaused = useMediaSelector((state) => state.mediaPaused ?? true);

	const isDisabled = disabled || context.disabled;

	const onPlayToggle = React.useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			props.onClick?.(event);

			if (event.defaultPrevented) return;

			dispatch({
				type: mediaPaused
					? MediaActionTypes.MEDIA_PLAY_REQUEST
					: MediaActionTypes.MEDIA_PAUSE_REQUEST,
			});
		},
		[dispatch, props.onClick, mediaPaused],
	);

	return (
		<MediaPlayerTooltip
			tooltip={mediaPaused ? "Play" : "Pause"}
			shortcut="Space"
		>
			<PlayerButton
				type="button"
				aria-controls={context.mediaId}
				aria-label={mediaPaused ? "Play" : "Pause"}
				aria-pressed={!mediaPaused}
				data-disabled={isDisabled ? "" : undefined}
				data-slot="media-player-play-button"
				data-state={mediaPaused ? "off" : "on"}
				disabled={isDisabled}
				{...playButtonProps}
				variant="ghost"
				size="icon"
				className={cn(
					"size-8 [&_svg:not([class*='fill-'])]:fill-current",
					className,
				)}
				onClick={onPlayToggle}
			>
				{children ?? (mediaPaused ? <PlayIcon /> : <PauseIcon />)}
			</PlayerButton>
		</MediaPlayerTooltip>
	);
}

interface MediaPlayerSeekBackwardProps
	extends React.ComponentProps<typeof Button> {
	seconds?: number;
}

function MediaPlayerSeekBackward(props: MediaPlayerSeekBackwardProps) {
	const {
		seconds = SEEK_STEP_SHORT,
		asChild,
		children,
		className,
		disabled,
		...seekBackwardProps
	} = props;

	const context = useMediaPlayerContext("MediaPlayerSeekBackward");
	const dispatch = useMediaDispatch();
	const mediaCurrentTime = useMediaSelector(
		(state) => state.mediaCurrentTime ?? 0,
	);

	const isDisabled = disabled || context.disabled;

	const onSeekBackward = React.useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			props.onClick?.(event);

			if (event.defaultPrevented) return;

			dispatch({
				type: MediaActionTypes.MEDIA_SEEK_REQUEST,
				detail: Math.max(0, mediaCurrentTime - seconds),
			});
		},
		[dispatch, props.onClick, mediaCurrentTime, seconds],
	);

	return (
		<MediaPlayerTooltip
			tooltip={`Back ${seconds}s`}
			shortcut={context.isVideo ? ["←"] : ["Shift ←"]}
		>
			<PlayerButton
				type="button"
				aria-controls={context.mediaId}
				aria-label={`Back ${seconds} seconds`}
				data-disabled={isDisabled ? "" : undefined}
				data-slot="media-player-seek-backward"
				disabled={isDisabled}
				{...seekBackwardProps}
				variant="ghost"
				size="icon"
				className={cn("size-8", className)}
				onClick={onSeekBackward}
			>
				{children ?? <RewindIcon />}
			</PlayerButton>
		</MediaPlayerTooltip>
	);
}

interface MediaPlayerSeekForwardProps
	extends React.ComponentProps<typeof Button> {
	seconds?: number;
}

function MediaPlayerSeekForward(props: MediaPlayerSeekForwardProps) {
	const {
		seconds = SEEK_STEP_LONG,
		asChild,
		children,
		className,
		disabled,
		...seekForwardProps
	} = props;

	const context = useMediaPlayerContext("MediaPlayerSeekForward");
	const dispatch = useMediaDispatch();
	const mediaCurrentTime = useMediaSelector(
		(state) => state.mediaCurrentTime ?? 0,
	);
	const [, seekableEnd] = useMediaSelector(
		(state) => state.mediaSeekable ?? [0, 0],
	);
	const isDisabled = disabled || context.disabled;

	const onSeekForward = React.useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			props.onClick?.(event);

			if (event.defaultPrevented) return;

			dispatch({
				type: MediaActionTypes.MEDIA_SEEK_REQUEST,
				detail: Math.min(
					seekableEnd ?? Number.POSITIVE_INFINITY,
					mediaCurrentTime + seconds,
				),
			});
		},
		[dispatch, props.onClick, mediaCurrentTime, seekableEnd, seconds],
	);

	return (
		<MediaPlayerTooltip
			tooltip={`Forward ${seconds}s`}
			shortcut={context.isVideo ? ["→"] : ["Shift →"]}
		>
			<PlayerButton
				type="button"
				aria-controls={context.mediaId}
				aria-label={`Forward ${seconds} seconds`}
				data-disabled={isDisabled ? "" : undefined}
				data-slot="media-player-seek-forward"
				disabled={isDisabled}
				{...seekForwardProps}
				variant="ghost"
				size="icon"
				className={cn("size-8", className)}
				onClick={onSeekForward}
			>
				{children ?? <FastForwardIcon />}
			</PlayerButton>
		</MediaPlayerTooltip>
	);
}

interface SeekState {
	isHovering: boolean;
	pendingSeekTime: number | null;
	hasInitialPosition: boolean;
}

interface MediaPlayerSeekProps
	extends React.ComponentProps<typeof SliderPrimitive.Root> {
	withTime?: boolean;
	withoutChapter?: boolean;
	withoutTooltip?: boolean;
	tooltipThumbnailSrc?: string | ((time: number) => string);
	tooltipTimeVariant?: "current" | "progress";
	tooltipSideOffset?: number;
	tooltipCollisionBoundary?: Element | Element[];
	tooltipCollisionPadding?:
		| number
		| Partial<Record<"top" | "right" | "bottom" | "left", number>>;
}

function MediaPlayerSeek(props: MediaPlayerSeekProps) {
	const {
		withTime = false,
		withoutChapter = false,
		withoutTooltip = false,
		tooltipTimeVariant = "current",
		tooltipThumbnailSrc,
		tooltipSideOffset,
		tooltipCollisionPadding = SEEK_COLLISION_PADDING,
		tooltipCollisionBoundary,
		className,
		disabled,
		...seekProps
	} = props;

	const context = useMediaPlayerContext(SEEK_NAME);
	const store = useStoreContext(SEEK_NAME);
	const dispatch = useMediaDispatch();
	const mediaCurrentTime = useMediaSelector(
		(state) => state.mediaCurrentTime ?? 0,
	);
	const [seekableStart = 0, seekableEnd = 0] = useMediaSelector(
		(state) => state.mediaSeekable ?? [0, 0],
	);
	const mediaBuffered = useMediaSelector((state) => state.mediaBuffered ?? []);
	const mediaEnded = useMediaSelector((state) => state.mediaEnded ?? false);

	const chapterCues = useMediaSelector(
		(state) => state.mediaChaptersCues ?? [],
	);
	const mediaPreviewTime = useMediaSelector((state) => state.mediaPreviewTime);
	const mediaPreviewImage = useMediaSelector(
		(state) => state.mediaPreviewImage,
	);
	const mediaPreviewCoords = useMediaSelector(
		(state) => state.mediaPreviewCoords,
	);

	const seekRef = React.useRef<HTMLDivElement>(null);
	const tooltipRef = React.useRef<HTMLDivElement>(null);
	const justCommittedRef = React.useRef<boolean>(false);

	const hoverTimeRef = React.useRef(0);
	const tooltipXRef = React.useRef(0);
	const tooltipYRef = React.useRef(0);
	const seekRectRef = React.useRef<DOMRect | null>(null);
	const collisionDataRef = React.useRef<{
		padding: { top: number; right: number; bottom: number; left: number };
		boundaries: Element[];
	} | null>(null);

	const [seekState, setSeekState] = React.useState<SeekState>({
		isHovering: false,
		pendingSeekTime: null,
		hasInitialPosition: false,
	});

	const rafIdRef = React.useRef<number | null>(null);
	const seekThrottleRef = React.useRef<number | null>(null);
	const hoverTimeoutRef = React.useRef<number | null>(null);
	const lastPointerXRef = React.useRef<number>(0);
	const lastPointerYRef = React.useRef<number>(0);
	const previewDebounceRef = React.useRef<number | null>(null);
	const pointerEnterTimeRef = React.useRef<number>(0);
	const horizontalMovementRef = React.useRef<number>(0);
	const verticalMovementRef = React.useRef<number>(0);
	const lastSeekCommitTimeRef = React.useRef<number>(0);

	const timeCache = React.useRef<Map<number, string>>(new Map());

	const displayValue = seekState.pendingSeekTime ?? mediaCurrentTime;

	const isDisabled = disabled || context.disabled;
	const tooltipDisabled =
		withoutTooltip || context.withoutTooltip || store.getState().menuOpen;

	const currentTooltipSideOffset =
		tooltipSideOffset ?? context.tooltipSideOffset;

	const getCachedTime = React.useCallback((time: number, duration: number) => {
		const roundedTime = Math.floor(time);
		const key = roundedTime + duration * 10000;

		if (timeCache.current.has(key)) {
			return timeCache.current.get(key) as string;
		}

		const formatted = timeUtils.formatTime(time, duration);
		timeCache.current.set(key, formatted);

		if (timeCache.current.size > 100) {
			timeCache.current.clear();
		}

		return formatted;
	}, []);

	const currentTime = getCachedTime(displayValue, seekableEnd);
	const duration = getCachedTime(seekableEnd, seekableEnd);
	const remainingTime = getCachedTime(seekableEnd - displayValue, seekableEnd);

	const onCollisionDataUpdate = React.useCallback(() => {
		if (collisionDataRef.current) return collisionDataRef.current;

		const padding =
			typeof tooltipCollisionPadding === "number"
				? {
						top: tooltipCollisionPadding,
						right: tooltipCollisionPadding,
						bottom: tooltipCollisionPadding,
						left: tooltipCollisionPadding,
					}
				: { top: 0, right: 0, bottom: 0, left: 0, ...tooltipCollisionPadding };

		const boundaries = tooltipCollisionBoundary
			? Array.isArray(tooltipCollisionBoundary)
				? tooltipCollisionBoundary
				: [tooltipCollisionBoundary]
			: ([context.rootRef.current].filter(Boolean) as Element[]);

		collisionDataRef.current = { padding, boundaries };
		return collisionDataRef.current;
	}, [tooltipCollisionPadding, tooltipCollisionBoundary, context.rootRef]);

	const getCurrentChapterCue = React.useCallback(
		(time: number) => {
			if (withoutChapter || chapterCues.length === 0) return null;
			return chapterCues.find((c) => time >= c.startTime && time < c.endTime);
		},
		[chapterCues, withoutChapter],
	);

	const getThumbnail = React.useCallback(
		(time: number) => {
			if (tooltipDisabled) return null;

			if (tooltipThumbnailSrc) {
				const src =
					typeof tooltipThumbnailSrc === "function"
						? tooltipThumbnailSrc(time)
						: tooltipThumbnailSrc;
				return { src, coords: null };
			}

			if (
				mediaPreviewTime !== undefined &&
				Math.abs(time - mediaPreviewTime) < 0.1 &&
				mediaPreviewImage
			) {
				return {
					src: mediaPreviewImage,
					coords: mediaPreviewCoords ?? null,
				};
			}

			return null;
		},
		[
			tooltipThumbnailSrc,
			mediaPreviewTime,
			mediaPreviewImage,
			mediaPreviewCoords,
			tooltipDisabled,
		],
	);

	const onPreviewUpdate = React.useCallback(
		(time: number) => {
			if (tooltipDisabled) return;

			if (previewDebounceRef.current) {
				cancelAnimationFrame(previewDebounceRef.current);
			}

			previewDebounceRef.current = requestAnimationFrame(() => {
				dispatch({
					type: MediaActionTypes.MEDIA_PREVIEW_REQUEST,
					detail: time,
				});
				previewDebounceRef.current = null;
			});
		},
		[dispatch, tooltipDisabled],
	);

	const onTooltipPositionUpdate = React.useCallback(
		(clientX: number) => {
			if (!seekRef.current) return;

			const tooltipWidth =
				tooltipRef.current?.offsetWidth ?? SEEK_TOOLTIP_WIDTH_FALLBACK;

			let x = clientX;
			const y = seekRectRef.current?.top ?? 0;

			const collisionData = onCollisionDataUpdate();
			const halfTooltipWidth = tooltipWidth / 2;

			let minLeft = 0;
			let maxRight = window.innerWidth;

			for (const boundary of collisionData.boundaries) {
				const boundaryRect = boundary.getBoundingClientRect();
				minLeft = Math.max(
					minLeft,
					boundaryRect.left + collisionData.padding.left,
				);
				maxRight = Math.min(
					maxRight,
					boundaryRect.right - collisionData.padding.right,
				);
			}

			if (x - halfTooltipWidth < minLeft) {
				x = minLeft + halfTooltipWidth;
			} else if (x + halfTooltipWidth > maxRight) {
				x = maxRight - halfTooltipWidth;
			}

			const viewportPadding = SEEK_COLLISION_PADDING;
			if (x - halfTooltipWidth < viewportPadding) {
				x = viewportPadding + halfTooltipWidth;
			} else if (x + halfTooltipWidth > window.innerWidth - viewportPadding) {
				x = window.innerWidth - viewportPadding - halfTooltipWidth;
			}

			tooltipXRef.current = x;
			tooltipYRef.current = y;

			if (tooltipRef.current) {
				tooltipRef.current.style.setProperty(SEEK_TOOLTIP_X, `${x}px`);
				tooltipRef.current.style.setProperty(SEEK_TOOLTIP_Y, `${y}px`);
			}

			if (!seekState.hasInitialPosition) {
				setSeekState((prev) => ({ ...prev, hasInitialPosition: true }));
			}
		},
		[onCollisionDataUpdate, seekState.hasInitialPosition],
	);

	const onHoverProgressUpdate = React.useCallback(() => {
		if (!seekRef.current || seekableEnd <= 0) return;

		const hoverPercent = Math.min(
			100,
			(hoverTimeRef.current / seekableEnd) * 100,
		);
		seekRef.current.style.setProperty(
			SEEK_HOVER_PERCENT,
			`${hoverPercent.toFixed(4)}%`,
		);
	}, [seekableEnd]);

	React.useEffect(() => {
		if (seekState.pendingSeekTime !== null) {
			const diff = Math.abs(mediaCurrentTime - seekState.pendingSeekTime);
			if (diff < 0.5) {
				setSeekState((prev) => ({ ...prev, pendingSeekTime: null }));
			}
		}
	}, [mediaCurrentTime, seekState.pendingSeekTime]);

	React.useEffect(() => {
		if (!seekState.isHovering || tooltipDisabled) return;

		function onScroll() {
			setSeekState((prev) => ({
				...prev,
				isHovering: false,
				hasInitialPosition: false,
			}));
			dispatch({
				type: MediaActionTypes.MEDIA_PREVIEW_REQUEST,
				detail: undefined,
			});
		}

		document.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			document.removeEventListener("scroll", onScroll);
		};
	}, [dispatch, seekState.isHovering, tooltipDisabled]);

	const bufferedProgress = React.useMemo(() => {
		if (mediaBuffered.length === 0 || seekableEnd <= 0) return 0;

		if (mediaEnded) return 1;

		const containingRange = mediaBuffered.find(
			([start, end]) => start <= mediaCurrentTime && mediaCurrentTime <= end,
		);

		if (containingRange) {
			return Math.min(1, containingRange[1] / seekableEnd);
		}

		return Math.min(1, seekableStart / seekableEnd);
	}, [mediaBuffered, mediaCurrentTime, seekableEnd, mediaEnded, seekableStart]);

	const onPointerEnter = React.useCallback(() => {
		if (seekRef.current) {
			seekRectRef.current = seekRef.current.getBoundingClientRect();
		}

		collisionDataRef.current = null;
		pointerEnterTimeRef.current = Date.now();
		horizontalMovementRef.current = 0;
		verticalMovementRef.current = 0;

		if (seekableEnd > 0) {
			if (hoverTimeoutRef.current) {
				clearTimeout(hoverTimeoutRef.current);
			}

			if (!tooltipDisabled) {
				if (lastPointerXRef.current && seekRectRef.current) {
					const clientX = Math.max(
						seekRectRef.current.left,
						Math.min(lastPointerXRef.current, seekRectRef.current.right),
					);
					onTooltipPositionUpdate(clientX);
				}
			}
		}
	}, [seekableEnd, onTooltipPositionUpdate, tooltipDisabled]);

	const onPointerLeave = React.useCallback(() => {
		if (hoverTimeoutRef.current) {
			clearTimeout(hoverTimeoutRef.current);
			hoverTimeoutRef.current = null;
		}
		if (rafIdRef.current) {
			cancelAnimationFrame(rafIdRef.current);
			rafIdRef.current = null;
		}
		if (previewDebounceRef.current) {
			cancelAnimationFrame(previewDebounceRef.current);
			previewDebounceRef.current = null;
		}

		setSeekState((prev) => ({
			...prev,
			isHovering: false,
			hasInitialPosition: false,
		}));

		justCommittedRef.current = false;
		seekRectRef.current = null;
		collisionDataRef.current = null;

		pointerEnterTimeRef.current = 0;
		horizontalMovementRef.current = 0;
		verticalMovementRef.current = 0;
		lastPointerXRef.current = 0;
		lastPointerYRef.current = 0;
		lastSeekCommitTimeRef.current = 0;

		if (!tooltipDisabled) {
			dispatch({
				type: MediaActionTypes.MEDIA_PREVIEW_REQUEST,
				detail: undefined,
			});
		}
	}, [dispatch, tooltipDisabled]);

	const onPointerMove = React.useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (seekableEnd <= 0) return;

			if (!seekRectRef.current && seekRef.current) {
				seekRectRef.current = seekRef.current.getBoundingClientRect();
			}

			if (!seekRectRef.current) return;

			const currentX = event.clientX;
			const currentY = event.clientY;

			if (lastPointerXRef.current !== 0 && lastPointerYRef.current !== 0) {
				const deltaX = Math.abs(currentX - lastPointerXRef.current);
				const deltaY = Math.abs(currentY - lastPointerYRef.current);

				horizontalMovementRef.current += deltaX;
				verticalMovementRef.current += deltaY;
			}

			lastPointerXRef.current = currentX;
			lastPointerYRef.current = currentY;

			if (rafIdRef.current) {
				cancelAnimationFrame(rafIdRef.current);
			}

			rafIdRef.current = requestAnimationFrame(() => {
				const wasJustCommitted = justCommittedRef.current;
				if (wasJustCommitted) {
					justCommittedRef.current = false;
				}

				const seekRect = seekRectRef.current;
				if (!seekRect) {
					rafIdRef.current = null;
					return;
				}

				const clientX = lastPointerXRef.current;
				const offsetXOnSeekBar = Math.max(
					0,
					Math.min(clientX - seekRect.left, seekRect.width),
				);
				const relativeX = offsetXOnSeekBar / seekRect.width;
				const calculatedHoverTime = relativeX * seekableEnd;

				hoverTimeRef.current = calculatedHoverTime;

				onHoverProgressUpdate();

				const wasHovering = seekState.isHovering;
				const isCurrentlyHovering =
					clientX >= seekRect.left && clientX <= seekRect.right;

				const timeHovering = Date.now() - pointerEnterTimeRef.current;
				const totalMovement =
					horizontalMovementRef.current + verticalMovementRef.current;
				const horizontalRatio =
					totalMovement > 0 ? horizontalMovementRef.current / totalMovement : 0;

				const timeSinceSeekCommit = Date.now() - lastSeekCommitTimeRef.current;
				const isInSeekCooldown = timeSinceSeekCommit < 300;

				const shouldShowTooltip =
					!wasJustCommitted &&
					!isInSeekCooldown &&
					(timeHovering > 150 ||
						horizontalRatio > 0.6 ||
						(totalMovement < 10 && timeHovering > 50));

				if (
					!wasHovering &&
					isCurrentlyHovering &&
					shouldShowTooltip &&
					!tooltipDisabled
				) {
					setSeekState((prev) => ({ ...prev, isHovering: true }));
				}

				if (!tooltipDisabled) {
					onPreviewUpdate(calculatedHoverTime);

					if (isCurrentlyHovering && (wasHovering || shouldShowTooltip)) {
						onTooltipPositionUpdate(clientX);
					}
				}

				rafIdRef.current = null;
			});
		},
		[
			onPreviewUpdate,
			onTooltipPositionUpdate,
			onHoverProgressUpdate,
			seekableEnd,
			seekState.isHovering,
			tooltipDisabled,
		],
	);

	const onSeek = React.useCallback(
		(value: number[]) => {
			const time = value[0] ?? 0;

			setSeekState((prev) => ({ ...prev, pendingSeekTime: time }));

			if (!store.getState().dragging) {
				store.setState("dragging", true);
			}

			if (seekThrottleRef.current) {
				cancelAnimationFrame(seekThrottleRef.current);
			}

			seekThrottleRef.current = requestAnimationFrame(() => {
				dispatch({
					type: MediaActionTypes.MEDIA_SEEK_REQUEST,
					detail: time,
				});
				seekThrottleRef.current = null;
			});
		},
		[dispatch, store.getState, store.setState],
	);

	const onSeekCommit = React.useCallback(
		(value: number[]) => {
			const time = value[0] ?? 0;

			if (seekThrottleRef.current) {
				cancelAnimationFrame(seekThrottleRef.current);
				seekThrottleRef.current = null;
			}

			if (hoverTimeoutRef.current) {
				clearTimeout(hoverTimeoutRef.current);
				hoverTimeoutRef.current = null;
			}
			if (rafIdRef.current) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = null;
			}
			if (previewDebounceRef.current) {
				cancelAnimationFrame(previewDebounceRef.current);
				previewDebounceRef.current = null;
			}

			setSeekState((prev) => ({
				...prev,
				pendingSeekTime: time,
				isHovering: false,
				hasInitialPosition: false,
			}));

			justCommittedRef.current = true;
			collisionDataRef.current = null;
			lastSeekCommitTimeRef.current = Date.now();

			// Reset movement tracking after seek commit
			pointerEnterTimeRef.current = Date.now();
			horizontalMovementRef.current = 0;
			verticalMovementRef.current = 0;

			if (store.getState().dragging) {
				store.setState("dragging", false);
			}

			dispatch({
				type: MediaActionTypes.MEDIA_SEEK_REQUEST,
				detail: time,
			});

			dispatch({
				type: MediaActionTypes.MEDIA_PREVIEW_REQUEST,
				detail: undefined,
			});
		},
		[dispatch, store.getState, store.setState],
	);

	React.useEffect(() => {
		return () => {
			if (seekThrottleRef.current) {
				cancelAnimationFrame(seekThrottleRef.current);
			}
			if (hoverTimeoutRef.current) {
				clearTimeout(hoverTimeoutRef.current);
			}
			if (rafIdRef.current) {
				cancelAnimationFrame(rafIdRef.current);
			}
			if (previewDebounceRef.current) {
				cancelAnimationFrame(previewDebounceRef.current);
			}
		};
	}, []);

	const currentChapterCue = getCurrentChapterCue(hoverTimeRef.current);
	const thumbnail = getThumbnail(hoverTimeRef.current);
	const hoverTime = getCachedTime(hoverTimeRef.current, seekableEnd);

	const chapterSeparators = React.useMemo(() => {
		if (withoutChapter || chapterCues.length <= 1 || seekableEnd <= 0) {
			return null;
		}

		return chapterCues.slice(1).map((chapterCue, index) => {
			const position = (chapterCue.startTime / seekableEnd) * 100;

			return (
				<div
					key={`chapter-${index}-${chapterCue.startTime}`}
					role="presentation"
					aria-hidden="true"
					data-slot="media-player-seek-chapter-separator"
					className="absolute top-0 h-full bg-black"
					style={{
						width: ".1563rem",
						left: `${position}%`,
						transform: "translateX(-50%)",
					}}
				/>
			);
		});
	}, [chapterCues, seekableEnd, withoutChapter]);

	const spriteStyle = React.useMemo<React.CSSProperties>(() => {
		if (!thumbnail?.coords || !thumbnail?.src) {
			return {};
		}

		const coordX = thumbnail.coords[0];
		const coordY = thumbnail.coords[1];

		const spriteWidth = Number.parseFloat(thumbnail.coords[2] ?? "0");
		const spriteHeight = Number.parseFloat(thumbnail.coords[3] ?? "0");

		const scaleX = spriteWidth > 0 ? SPRITE_CONTAINER_WIDTH / spriteWidth : 1;
		const scaleY =
			spriteHeight > 0 ? SPRITE_CONTAINER_HEIGHT / spriteHeight : 1;
		const scale = Math.min(scaleX, scaleY);

		return {
			width: `${spriteWidth}px`,
			height: `${spriteHeight}px`,
			backgroundImage: `url(${thumbnail.src})`,
			backgroundPosition: `-${coordX}px -${coordY}px`,
			backgroundRepeat: "no-repeat",
			transform: `scale(${scale})`,
			transformOrigin: "top left",
		};
	}, [thumbnail?.coords, thumbnail?.src]);

	const SeekSlider = (
		<div data-slot="media-player-seek-container" className="relative w-full">
			<SliderPrimitive.Root
				aria-controls={context.mediaId}
				aria-valuetext={`${currentTime} of ${duration}`}
				data-hovering={seekState.isHovering ? "" : undefined}
				data-slider=""
				data-slot="media-player-seek"
				disabled={isDisabled}
				{...seekProps}
				ref={seekRef}
				min={seekableStart}
				max={seekableEnd}
				step={0.01}
				className={cn(
					"flex relative items-center w-full select-none touch-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
					className,
				)}
				value={[displayValue]}
				onValueChange={onSeek}
				onValueCommit={onSeekCommit}
				onPointerEnter={onPointerEnter}
				onPointerLeave={onPointerLeave}
				onPointerMove={onPointerMove}
			>
				<SliderPrimitive.Track className="overflow-hidden relative w-full h-1 rounded-full grow bg-white/40">
					<div
						data-slot="media-player-seek-buffered"
						className="absolute h-full bg-white/10 will-change-[width]"
						style={{
							width: `${bufferedProgress * 100}%`,
						}}
					/>
					<SliderPrimitive.Range className="absolute h-full bg-white will-change-[width]" />
					{seekState.isHovering && seekableEnd > 0 && (
						<div
							data-slot="media-player-seek-hover-range"
							className="absolute h-full bg-white/70 will-change-[width,opacity]"
							style={{
								width: `var(${SEEK_HOVER_PERCENT}, 0%)`,
								transition: "opacity 150ms ease-out",
							}}
						/>
					)}
					{chapterSeparators}
				</SliderPrimitive.Track>
				<SliderPrimitive.Thumb className="relative z-10 block size-3 shrink-0 rounded-full bg-white shadow-sm  transition-[color,box-shadow] will-change-transform focus-visible:outline-hidden outline-0 disabled:pointer-events-none disabled:opacity-50" />
			</SliderPrimitive.Root>
			{!withoutTooltip &&
				!context.withoutTooltip &&
				seekState.isHovering &&
				seekableEnd > 0 && (
					<MediaPlayerPortal>
						<div
							ref={tooltipRef}
							className="pointer-events-none z-50 [backface-visibility:hidden] [contain:layout_style] [transition:opacity_150ms_ease-in-out]"
							style={{
								position: "fixed" as const,
								left: `var(${SEEK_TOOLTIP_X}, 0rem)`,
								top: `var(${SEEK_TOOLTIP_Y}, 0rem)`,
								transform: `translateX(-50%) translateY(calc(-100% - ${currentTooltipSideOffset}px))`,
								visibility: seekState.hasInitialPosition ? "visible" : "hidden",
								opacity: seekState.hasInitialPosition ? 1 : 0,
							}}
						>
							<div
								className={cn(
									"flex flex-col items-center gap-1.5 rounded-md border border-white/10 bg-gray-12 text-foreground shadow-sm",
									thumbnail && "min-h-10",
									!thumbnail && currentChapterCue && "px-3 py-1.5",
								)}
							>
								{thumbnail?.src && (
									<div
										data-slot="media-player-seek-thumbnail"
										className="overflow-hidden rounded-md rounded-b-none"
										style={{
											width: `${SPRITE_CONTAINER_WIDTH}px`,
											height: `${SPRITE_CONTAINER_HEIGHT}px`,
										}}
									>
										{thumbnail.coords ? (
											<div style={spriteStyle} />
										) : (
											<img
												src={thumbnail.src}
												alt={`Preview at ${hoverTime}`}
												className="object-cover size-full"
											/>
										)}
									</div>
								)}
								{currentChapterCue && (
									<div
										data-slot="media-player-seek-chapter-title"
										className="text-xs text-center text-white line-clamp-2 max-w-48"
									>
										{currentChapterCue.text}
									</div>
								)}
								<div
									data-slot="media-player-seek-time"
									className={cn(
										"whitespace-nowrap text-center text-xs text-white tabular-nums",
										thumbnail && "pb-1.5",
										!(thumbnail || currentChapterCue) && "px-2.5 py-1",
									)}
								>
									{tooltipTimeVariant === "progress"
										? `${hoverTime} / ${duration}`
										: hoverTime}
								</div>
							</div>
						</div>
					</MediaPlayerPortal>
				)}
		</div>
	);

	if (withTime) {
		return (
			<div className="flex gap-2 items-center w-full">
				<span className="text-sm tabular-nums">{currentTime}</span>
				{SeekSlider}
				<span className="text-sm tabular-nums">{remainingTime}</span>
			</div>
		);
	}

	return SeekSlider;
}

interface MediaPlayerVolumeProps
	extends React.ComponentProps<typeof SliderPrimitive.Root> {
	asChild?: boolean;
	expandable?: boolean;
	enhancedAudioEnabled?: boolean;
}

function MediaPlayerVolume(props: MediaPlayerVolumeProps) {
	const {
		asChild,
		expandable = false,
		enhancedAudioEnabled = false,
		className,
		disabled,
		...volumeProps
	} = props;

	const context = useMediaPlayerContext(VOLUME_NAME);
	const store = useStoreContext(VOLUME_NAME);
	const dispatch = useMediaDispatch();
	const mediaVolume = useMediaSelector((state) => state.mediaVolume ?? 1);
	const mediaMuted = useMediaSelector((state) => state.mediaMuted ?? false);
	const mediaVolumeLevel = useMediaSelector(
		(state) => state.mediaVolumeLevel ?? "high",
	);

	const sliderId = React.useId();
	const volumeTriggerId = React.useId();

	const isDisabled = disabled || context.disabled;

	const displayMuted = mediaMuted;

	const onMute = React.useCallback(() => {
		dispatch({
			type: mediaMuted
				? MediaActionTypes.MEDIA_UNMUTE_REQUEST
				: MediaActionTypes.MEDIA_MUTE_REQUEST,
		});
	}, [dispatch, mediaMuted]);

	const onVolumeChange = React.useCallback(
		(value: number[]) => {
			const volume = value[0] ?? 0;

			if (!store.getState().dragging) {
				store.setState("dragging", true);
			}

			dispatch({
				type: MediaActionTypes.MEDIA_VOLUME_REQUEST,
				detail: volume,
			});
		},
		[dispatch, store.getState, store.setState],
	);

	const onVolumeCommit = React.useCallback(
		(value: number[]) => {
			const volume = value[0] ?? 0;

			if (store.getState().dragging) {
				store.setState("dragging", false);
			}

			dispatch({
				type: MediaActionTypes.MEDIA_VOLUME_REQUEST,
				detail: volume,
			});
		},
		[dispatch, store],
	);

	const effectiveVolume = displayMuted ? 0 : mediaVolume;

	return (
		<div
			data-disabled={isDisabled ? "" : undefined}
			data-slot="media-player-volume-container"
			className={cn(
				"group flex items-center",
				expandable
					? "gap-0 group-focus-within:gap-2 group-hover:gap-1.5"
					: "gap-1.5",
				className,
			)}
		>
			<MediaPlayerTooltip tooltip="Volume" shortcut="M">
				<PlayerButton
					id={volumeTriggerId}
					type="button"
					aria-controls={`${context.mediaId} ${sliderId}`}
					aria-label={displayMuted ? "Unmute" : "Mute"}
					aria-pressed={displayMuted}
					data-slot="media-player-volume-trigger"
					data-state={displayMuted ? "on" : "off"}
					variant="ghost"
					size="icon"
					className="size-8"
					disabled={isDisabled}
					onClick={onMute}
				>
					{mediaVolumeLevel === "off" || displayMuted ? (
						<VolumeXIcon />
					) : mediaVolumeLevel === "high" ? (
						<Volume2Icon />
					) : (
						<Volume1Icon />
					)}
				</PlayerButton>
			</MediaPlayerTooltip>
			<SliderPrimitive.Root
				id={sliderId}
				aria-controls={context.mediaId}
				aria-valuetext={`${Math.round(effectiveVolume * 100)}% volume`}
				data-slider=""
				data-slot="media-player-volume"
				{...volumeProps}
				min={0}
				max={1}
				step={0.1}
				className={cn(
					"flex relative items-center select-none touch-none",
					expandable
						? "w-0 opacity-0 transition-[width,opacity] duration-200 ease-in-out group-focus-within:w-16 group-focus-within:opacity-100 group-hover:w-16 group-hover:opacity-100"
						: "w-16",
					className,
				)}
				disabled={isDisabled}
				value={[effectiveVolume]}
				onValueChange={onVolumeChange}
				onValueCommit={onVolumeCommit}
			>
				<SliderPrimitive.Track className="overflow-hidden relative w-full h-1 rounded-full grow bg-zinc-500">
					<SliderPrimitive.Range className="absolute h-full bg-white will-change-[width]" />
				</SliderPrimitive.Track>
				<SliderPrimitive.Thumb className="block size-2.5 shrink-0 rounded-full bg-white shadow-sm ring-ring/50 transition-[color,box-shadow] will-change-transform hover:ring-4 focus-visible:outline-hidden focus-visible:ring-4 disabled:pointer-events-none disabled:opacity-50" />
			</SliderPrimitive.Root>
		</div>
	);
}

interface MediaPlayerTimeProps extends React.ComponentProps<"div"> {
	variant?: "progress" | "remaining" | "duration";
	asChild?: boolean;
}

function MediaPlayerTime(props: MediaPlayerTimeProps) {
	const { variant = "progress", asChild, className, ...timeProps } = props;

	const context = useMediaPlayerContext("MediaPlayerTime");
	const mediaCurrentTime = useMediaSelector(
		(state) => state.mediaCurrentTime ?? 0,
	);
	const [, seekableEnd = 0] = useMediaSelector(
		(state) => state.mediaSeekable ?? [0, 0],
	);

	const times = React.useMemo(() => {
		if (variant === "remaining") {
			return {
				remaining: timeUtils.formatTime(
					seekableEnd - mediaCurrentTime,
					seekableEnd,
				),
			};
		}

		if (variant === "duration") {
			return {
				duration: timeUtils.formatTime(seekableEnd, seekableEnd),
			};
		}

		return {
			current: timeUtils.formatTime(mediaCurrentTime, seekableEnd),
			duration: timeUtils.formatTime(seekableEnd, seekableEnd),
		};
	}, [variant, mediaCurrentTime, seekableEnd]);

	const TimePrimitive = asChild ? Slot : "div";

	if (variant === "remaining" || variant === "duration") {
		return (
			<TimePrimitive
				data-slot="media-player-time"
				data-variant={variant}
				dir={context.dir}
				{...timeProps}
				className={cn("text-sm tabular-nums text-white", className)}
			>
				{times[variant]}
			</TimePrimitive>
		);
	}

	return (
		<TimePrimitive
			data-slot="media-player-time"
			data-variant={variant}
			dir={context.dir}
			{...timeProps}
			className={cn(
				"flex gap-1 items-center text-sm text-white min-w-fit",
				className,
			)}
		>
			<span className="text-xs tabular-nums text-white min-w-fit md:text-base">
				{times.current}
			</span>
			<span
				className="text-xs tabular-nums text-gray-11"
				role="separator"
				aria-hidden="true"
				tabIndex={-1}
			>
				/
			</span>
			<span className="text-xs tabular-nums text-white min-w-fit md:text-base">
				{times.duration}
			</span>
		</TimePrimitive>
	);
}

interface MediaPlayerPlaybackSpeedProps
	extends React.ComponentProps<typeof DropdownMenuTrigger>,
		React.ComponentProps<typeof Button>,
		Omit<React.ComponentProps<typeof DropdownMenu>, "dir">,
		Pick<React.ComponentProps<typeof DropdownMenuContent>, "sideOffset"> {
	speeds?: number[];
}

function MediaPlayerPlaybackSpeed(props: MediaPlayerPlaybackSpeedProps) {
	const {
		open,
		defaultOpen,
		onOpenChange: onOpenChangeProp,
		sideOffset = FLOATING_MENU_SIDE_OFFSET,
		speeds = SPEEDS,
		asChild,
		modal = false,
		className,
		disabled,
		...playbackSpeedProps
	} = props;

	const context = useMediaPlayerContext(PLAYBACK_SPEED_NAME);
	const store = useStoreContext(PLAYBACK_SPEED_NAME);
	const dispatch = useMediaDispatch();
	const mediaPlaybackRate = useMediaSelector(
		(state) => state.mediaPlaybackRate ?? 1,
	);

	const isDisabled = disabled || context.disabled;

	const onPlaybackRateChange = React.useCallback(
		(rate: number) => {
			dispatch({
				type: MediaActionTypes.MEDIA_PLAYBACK_RATE_REQUEST,
				detail: rate,
			});
		},
		[dispatch],
	);

	const onOpenChange = React.useCallback(
		(open: boolean) => {
			store.setState("menuOpen", open);
			onOpenChangeProp?.(open);
		},
		[store.setState, onOpenChangeProp],
	);

	return (
		<DropdownMenu
			modal={modal}
			open={open}
			defaultOpen={defaultOpen}
			onOpenChange={onOpenChange}
		>
			<MediaPlayerTooltip tooltip="Playback speed" shortcut={["<", ">"]}>
				<DropdownMenuTrigger asChild>
					<PlayerButton
						type="button"
						aria-controls={context.mediaId}
						disabled={isDisabled}
						{...playbackSpeedProps}
						variant="ghost"
						size="icon"
						className={cn(
							"h-8 w-16 aria-[expanded=true]:bg-white/50",
							className,
						)}
					>
						{mediaPlaybackRate}x
					</PlayerButton>
				</DropdownMenuTrigger>
			</MediaPlayerTooltip>
			<DropdownMenuContent
				container={context.portalContainer}
				sideOffset={sideOffset}
				align="center"
				className="min-w-[var(--radix-dropdown-menu-trigger-width)] data-[side=top]:mb-3.5"
			>
				{speeds.map((speed) => (
					<DropdownMenuItem
						key={speed}
						className="justify-between"
						onSelect={() => onPlaybackRateChange(speed)}
					>
						{speed}x{mediaPlaybackRate === speed && <CheckIcon />}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

interface MediaPlayerLoopProps extends React.ComponentProps<typeof Button> {}

function MediaPlayerLoop(props: MediaPlayerLoopProps) {
	const { children, className, disabled, ...loopProps } = props;

	const context = useMediaPlayerContext("MediaPlayerLoop");
	const isDisabled = disabled || context.disabled;

	const [isLooping, setIsLooping] = React.useState(() => {
		const mediaElement = context.mediaRef.current;
		return mediaElement?.loop ?? false;
	});

	React.useEffect(() => {
		const mediaElement = context.mediaRef.current;
		if (!mediaElement) return;

		setIsLooping(mediaElement.loop);

		const checkLoop = () => setIsLooping(mediaElement.loop);
		const observer = new MutationObserver(checkLoop);
		observer.observe(mediaElement, {
			attributes: true,
			attributeFilter: ["loop"],
		});

		return () => observer.disconnect();
	}, [context.mediaRef]);

	const onLoopToggle = React.useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			props.onClick?.(event);
			if (event.defaultPrevented) return;

			const mediaElement = context.mediaRef.current;
			if (mediaElement) {
				const newLoopState = !mediaElement.loop;
				mediaElement.loop = newLoopState;
				setIsLooping(newLoopState);
			}
		},
		[context.mediaRef, props.onClick],
	);

	return (
		<MediaPlayerTooltip
			tooltip={isLooping ? "Disable loop" : "Enable loop"}
			shortcut="R"
		>
			<PlayerButton
				type="button"
				aria-controls={context.mediaId}
				aria-label={isLooping ? "Disable loop" : "Enable loop"}
				aria-pressed={isLooping}
				data-disabled={isDisabled ? "" : undefined}
				data-slot="media-player-loop"
				data-state={isLooping ? "on" : "off"}
				disabled={isDisabled}
				{...loopProps}
				variant="ghost"
				size="icon"
				className={cn("size-8", className)}
				onClick={onLoopToggle}
			>
				{children ??
					(isLooping ? (
						<RepeatIcon className="text-muted-foreground" />
					) : (
						<RepeatIcon />
					))}
			</PlayerButton>
		</MediaPlayerTooltip>
	);
}

interface MediaPlayerFullscreenProps
	extends React.ComponentProps<typeof Button> {}

function MediaPlayerFullscreen(props: MediaPlayerFullscreenProps) {
	const { children, className, disabled, ...fullscreenProps } = props;

	const context = useMediaPlayerContext("MediaPlayerFullscreen");
	const dispatch = useMediaDispatch();
	const isFullscreen = useMediaSelector(
		(state) => state.mediaIsFullscreen ?? false,
	);

	const isDisabled = disabled || context.disabled;

	const onFullscreen = React.useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			props.onClick?.(event);

			if (event.defaultPrevented) return;

			dispatch({
				type: isFullscreen
					? MediaActionTypes.MEDIA_EXIT_FULLSCREEN_REQUEST
					: MediaActionTypes.MEDIA_ENTER_FULLSCREEN_REQUEST,
			});
		},
		[dispatch, props.onClick, isFullscreen],
	);

	return (
		<MediaPlayerTooltip tooltip="Fullscreen" shortcut="F">
			<PlayerButton
				type="button"
				aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
				data-disabled={isDisabled ? "" : undefined}
				data-slot="media-player-fullscreen"
				data-state={isFullscreen ? "on" : "off"}
				disabled={isDisabled}
				{...fullscreenProps}
				variant="ghost"
				size="icon"
				className={cn("size-8", className)}
				onClick={onFullscreen}
			>
				{children ?? (isFullscreen ? <Minimize2Icon /> : <Maximize2Icon />)}
			</PlayerButton>
		</MediaPlayerTooltip>
	);
}

interface MediaPlayerPiPProps extends React.ComponentProps<typeof Button> {
	onPipError?: (error: unknown, state: "enter" | "exit") => void;
}

function MediaPlayerPiP(props: MediaPlayerPiPProps) {
	const { children, className, onPipError, disabled, ...pipButtonProps } =
		props;

	const context = useMediaPlayerContext("MediaPlayerPiP");
	const dispatch = useMediaDispatch();
	const isPictureInPicture = useMediaSelector(
		(state) => state.mediaIsPip ?? false,
	);

	const isDisabled = disabled || context.disabled;

	const onPictureInPicture = React.useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			props.onClick?.(event);

			if (event.defaultPrevented) return;

			dispatch({
				type: isPictureInPicture
					? MediaActionTypes.MEDIA_EXIT_PIP_REQUEST
					: MediaActionTypes.MEDIA_ENTER_PIP_REQUEST,
			});

			const mediaElement = context.mediaRef.current;

			if (mediaElement instanceof HTMLVideoElement) {
				if (isPictureInPicture) {
					document.exitPictureInPicture().catch((error) => {
						onPipError?.(error, "exit");
					});
				} else {
					mediaElement.requestPictureInPicture().catch((error) => {
						onPipError?.(error, "enter");
					});
				}
			}
		},
		[dispatch, props.onClick, isPictureInPicture, onPipError, context.mediaRef],
	);

	return (
		<MediaPlayerTooltip tooltip="Picture in picture" shortcut="P">
			<PlayerButton
				type="button"
				aria-controls={context.mediaId}
				aria-label={isPictureInPicture ? "Exit pip" : "Enter pip"}
				data-disabled={isDisabled ? "" : undefined}
				data-slot="media-player-pip"
				data-state={isPictureInPicture ? "on" : "off"}
				disabled={isDisabled}
				{...pipButtonProps}
				variant="ghost"
				size="icon"
				className={cn("size-8", className)}
				onClick={onPictureInPicture}
			>
				{isPictureInPicture ? (
					<PictureInPicture2Icon />
				) : (
					<PictureInPictureIcon />
				)}
			</PlayerButton>
		</MediaPlayerTooltip>
	);
}

interface MediaPlayerCaptionsProps extends React.ComponentProps<typeof Button> {
	setToggleCaptions?: (toggleCaptions: boolean) => void;
	toggleCaptions?: boolean;
}

function MediaPlayerCaptions(props: MediaPlayerCaptionsProps) {
	const {
		children,
		className,
		disabled,
		toggleCaptions,
		setToggleCaptions,
		...captionsProps
	} = props;

	const context = useMediaPlayerContext("MediaPlayerCaptions");

	const isDisabled = disabled || context.disabled;
	const onCaptionsToggle = React.useCallback(() => {
		setToggleCaptions?.(!toggleCaptions);
	}, [toggleCaptions, setToggleCaptions]);

	return (
		<MediaPlayerTooltip tooltip="Captions">
			<PlayerButton
				type="button"
				aria-controls={context.mediaId}
				aria-label={toggleCaptions ? "Disable captions" : "Enable captions"}
				aria-pressed={toggleCaptions}
				data-disabled={isDisabled ? "" : undefined}
				data-slot="media-player-captions"
				data-state={toggleCaptions ? "on" : "off"}
				disabled={isDisabled}
				{...captionsProps}
				variant="ghost"
				size="icon"
				className={cn("size-8", className)}
				onClick={onCaptionsToggle}
			>
				{children ?? (toggleCaptions ? <SubtitlesIcon /> : <CaptionsOffIcon />)}
			</PlayerButton>
		</MediaPlayerTooltip>
	);
}

type EnhancedAudioStatus = "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";

interface MediaPlayerEnhancedAudioProps
	extends React.ComponentProps<typeof Button> {
	enhancedAudioStatus?: EnhancedAudioStatus | null;
	enhancedAudioEnabled?: boolean;
	setEnhancedAudioEnabled?: (enabled: boolean) => void;
}

function MediaPlayerEnhancedAudio(props: MediaPlayerEnhancedAudioProps) {
	const {
		children,
		className,
		disabled,
		enhancedAudioStatus,
		enhancedAudioEnabled,
		setEnhancedAudioEnabled,
		...enhancedAudioProps
	} = props;

	const context = useMediaPlayerContext("MediaPlayerEnhancedAudio");

	const isProcessing = enhancedAudioStatus === "PROCESSING";
	const isComplete = enhancedAudioStatus === "COMPLETE";
	const isDisabled = disabled || context.disabled || !isComplete;

	const onEnhancedAudioToggle = React.useCallback(() => {
		if (isComplete) {
			setEnhancedAudioEnabled?.(!enhancedAudioEnabled);
		}
	}, [enhancedAudioEnabled, setEnhancedAudioEnabled, isComplete]);

	if (
		!enhancedAudioStatus ||
		enhancedAudioStatus === "ERROR" ||
		enhancedAudioStatus === "SKIPPED"
	) {
		return null;
	}

	const tooltipText = isProcessing
		? "Enhancing audio..."
		: enhancedAudioEnabled
			? "Enhanced audio on"
			: "Enhance audio";

	return (
		<MediaPlayerTooltip tooltip={tooltipText}>
			<PlayerButton
				type="button"
				aria-controls={context.mediaId}
				aria-label={
					isProcessing
						? "Audio enhancement in progress"
						: enhancedAudioEnabled
							? "Disable enhanced audio"
							: "Enable enhanced audio"
				}
				aria-pressed={enhancedAudioEnabled}
				data-disabled={isDisabled ? "" : undefined}
				data-slot="media-player-enhanced-audio"
				data-state={enhancedAudioEnabled ? "on" : "off"}
				disabled={isDisabled}
				{...enhancedAudioProps}
				variant="ghost"
				size="icon"
				className={cn(
					"size-8",
					enhancedAudioEnabled && "text-blue-500",
					className,
				)}
				onClick={onEnhancedAudioToggle}
			>
				{children ??
					(isProcessing ? (
						<Loader2Icon className="animate-spin" />
					) : (
						<SparklesIcon />
					))}
			</PlayerButton>
		</MediaPlayerTooltip>
	);
}

interface EnhancedAudioSyncProps {
	enhancedAudioRef: React.RefObject<HTMLAudioElement | null>;
	videoRef: React.RefObject<HTMLVideoElement | null>;
	enhancedAudioEnabled: boolean;
}

function EnhancedAudioSync({
	enhancedAudioRef,
	videoRef,
	enhancedAudioEnabled,
}: EnhancedAudioSyncProps) {
	const mediaVolume = useMediaSelector((state) => state.mediaVolume ?? 1);
	const mediaMuted = useMediaSelector((state) => state.mediaMuted ?? false);
	const dispatch = useMediaDispatch();
	const wasEnhancedRef = React.useRef(false);
	const savedVolumeRef = React.useRef(1);

	if (mediaVolume > 0) {
		savedVolumeRef.current = mediaVolume;
	}

	const effectiveVolume =
		mediaVolume > 0 ? mediaVolume : savedVolumeRef.current;

	React.useEffect(() => {
		if (enhancedAudioEnabled && !wasEnhancedRef.current) {
			wasEnhancedRef.current = true;
			dispatch({
				type: MediaActionTypes.MEDIA_UNMUTE_REQUEST,
			});
			if (mediaVolume === 0) {
				dispatch({
					type: MediaActionTypes.MEDIA_VOLUME_REQUEST,
					detail: savedVolumeRef.current,
				});
			}
		} else if (!enhancedAudioEnabled) {
			wasEnhancedRef.current = false;
		}
	}, [enhancedAudioEnabled, mediaVolume, dispatch]);

	const syncEnhancedAudio = React.useCallback(() => {
		if (!enhancedAudioRef.current || !videoRef.current) return;
		enhancedAudioRef.current.currentTime = videoRef.current.currentTime;
		enhancedAudioRef.current.playbackRate = videoRef.current.playbackRate;
	}, [enhancedAudioRef, videoRef]);

	React.useEffect(() => {
		const video = videoRef.current;
		const audio = enhancedAudioRef.current;
		if (!video || !audio) return;

		const handlePlay = () => {
			if (enhancedAudioEnabled && !mediaMuted) {
				audio.muted = false;
				audio.volume = effectiveVolume;
				syncEnhancedAudio();
				audio.play().catch(() => {});
			}
		};

		const handlePause = () => {
			audio.pause();
		};

		const handleSeeked = () => {
			if (enhancedAudioEnabled) {
				syncEnhancedAudio();
			}
		};

		const handleRateChange = () => {
			if (enhancedAudioEnabled) {
				audio.playbackRate = video.playbackRate;
			}
		};

		video.addEventListener("play", handlePlay);
		video.addEventListener("pause", handlePause);
		video.addEventListener("seeked", handleSeeked);
		video.addEventListener("ratechange", handleRateChange);

		return () => {
			video.removeEventListener("play", handlePlay);
			video.removeEventListener("pause", handlePause);
			video.removeEventListener("seeked", handleSeeked);
			video.removeEventListener("ratechange", handleRateChange);
		};
	}, [
		enhancedAudioEnabled,
		mediaMuted,
		effectiveVolume,
		syncEnhancedAudio,
		videoRef,
		enhancedAudioRef,
	]);

	React.useEffect(() => {
		const video = videoRef.current;
		const audio = enhancedAudioRef.current;
		if (!video || !audio) return;

		if (enhancedAudioEnabled) {
			video.muted = true;
			if (!mediaMuted) {
				audio.muted = false;
				audio.volume = effectiveVolume;
				if (!video.paused) {
					syncEnhancedAudio();
					audio.play().catch(() => {});
				}
			} else {
				audio.pause();
			}
		} else {
			video.muted = mediaMuted;
			audio.pause();
		}
	}, [
		enhancedAudioEnabled,
		mediaMuted,
		effectiveVolume,
		syncEnhancedAudio,
		videoRef,
		enhancedAudioRef,
	]);

	return null;
}

interface MediaPlayerDownloadProps
	extends React.ComponentProps<typeof Button> {}

function MediaPlayerDownload(props: MediaPlayerDownloadProps) {
	const { children, className, disabled, ...downloadProps } = props;

	const context = useMediaPlayerContext("MediaPlayerDownload");

	const isDisabled = disabled || context.disabled;

	const onDownload = React.useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			props.onClick?.(event);

			if (event.defaultPrevented) return;

			const mediaElement = context.mediaRef.current;

			if (!mediaElement || !mediaElement.currentSrc) return;

			const link = document.createElement("a");
			link.href = mediaElement.currentSrc;
			link.download = "";
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
		},
		[context.mediaRef, props.onClick],
	);

	return (
		<MediaPlayerTooltip tooltip="Download" shortcut="D">
			<PlayerButton
				type="button"
				aria-controls={context.mediaId}
				aria-label="Download"
				data-disabled={isDisabled ? "" : undefined}
				data-slot="media-player-download"
				disabled={isDisabled}
				{...downloadProps}
				variant="ghost"
				size="icon"
				className={cn("size-8", className)}
				onClick={onDownload}
			>
				{children ?? <DownloadIcon />}
			</PlayerButton>
		</MediaPlayerTooltip>
	);
}

interface MediaPlayerSettingsProps extends MediaPlayerPlaybackSpeedProps {
	enhancedAudioStatus?: EnhancedAudioStatus | null;
	enhancedAudioEnabled?: boolean;
	setEnhancedAudioEnabled?: (enabled: boolean) => void;
}

function MediaPlayerSettings(props: MediaPlayerSettingsProps) {
	const {
		open,
		defaultOpen,
		onOpenChange: onOpenChangeProp,
		sideOffset = FLOATING_MENU_SIDE_OFFSET,
		speeds = SPEEDS,
		asChild,
		modal = false,
		className,
		disabled,
		enhancedAudioStatus,
		enhancedAudioEnabled,
		setEnhancedAudioEnabled,
		...settingsProps
	} = props;

	const context = useMediaPlayerContext(SETTINGS_NAME);
	const store = useStoreContext(SETTINGS_NAME);
	const dispatch = useMediaDispatch();

	const mediaPlaybackRate = useMediaSelector(
		(state) => state.mediaPlaybackRate ?? 1,
	);
	const mediaSubtitlesList = useMediaSelector(
		(state) => state.mediaSubtitlesList ?? [],
	);
	const mediaSubtitlesShowing = useMediaSelector(
		(state) => state.mediaSubtitlesShowing ?? [],
	);
	const mediaRenditionList = useMediaSelector(
		(state) => state.mediaRenditionList ?? [],
	);
	const selectedRenditionId = useMediaSelector(
		(state) => state.mediaRenditionSelected,
	);

	const isDisabled = disabled || context.disabled;
	const isSubtitlesActive = mediaSubtitlesShowing.length > 0;

	const onPlaybackRateChange = React.useCallback(
		(rate: number) => {
			dispatch({
				type: MediaActionTypes.MEDIA_PLAYBACK_RATE_REQUEST,
				detail: rate,
			});
		},
		[dispatch],
	);

	const onRenditionChange = React.useCallback(
		(renditionId: string) => {
			dispatch({
				type: MediaActionTypes.MEDIA_RENDITION_REQUEST,
				detail: renditionId === "auto" ? undefined : renditionId,
			});
		},
		[dispatch],
	);

	const _onSubtitlesToggle = React.useCallback(() => {
		dispatch({
			type: MediaActionTypes.MEDIA_TOGGLE_SUBTITLES_REQUEST,
			detail: false,
		});
	}, [dispatch]);

	const _onShowSubtitleTrack = React.useCallback(
		(subtitleTrack: (typeof mediaSubtitlesList)[number]) => {
			dispatch({
				type: MediaActionTypes.MEDIA_TOGGLE_SUBTITLES_REQUEST,
				detail: false,
			});
			dispatch({
				type: MediaActionTypes.MEDIA_SHOW_SUBTITLES_REQUEST,
				detail: subtitleTrack,
			});
		},
		[dispatch],
	);

	const _selectedSubtitleLabel = React.useMemo(() => {
		if (!isSubtitlesActive) return "Off";
		if (mediaSubtitlesShowing.length > 0) {
			return mediaSubtitlesShowing[0]?.label ?? "On";
		}
		return "Off";
	}, [isSubtitlesActive, mediaSubtitlesShowing]);

	const selectedRenditionLabel = React.useMemo(() => {
		if (!selectedRenditionId) return "Auto";

		const currentRendition = mediaRenditionList?.find(
			(rendition) => rendition.id === selectedRenditionId,
		);
		if (!currentRendition) return "Auto";

		if (currentRendition.height) return `${currentRendition.height}p`;
		if (currentRendition.width) return `${currentRendition.width}p`;
		return currentRendition.id ?? "Auto";
	}, [selectedRenditionId, mediaRenditionList]);

	const onOpenChange = React.useCallback(
		(open: boolean) => {
			store.setState("menuOpen", open);
			onOpenChangeProp?.(open);
		},
		[store.setState, onOpenChangeProp],
	);

	return (
		<DropdownMenu
			modal={modal}
			open={open}
			defaultOpen={defaultOpen}
			onOpenChange={onOpenChange}
		>
			<MediaPlayerTooltip tooltip="Settings">
				<DropdownMenuTrigger asChild>
					<PlayerButton
						type="button"
						aria-controls={context.mediaId}
						aria-label="Settings"
						data-disabled={isDisabled ? "" : undefined}
						data-slot="media-player-settings"
						disabled={isDisabled}
						{...settingsProps}
						variant="ghost"
						size="icon"
						className={cn("size-8 aria-[expanded=true]:bg-white/50", className)}
					>
						<SettingsIcon />
					</PlayerButton>
				</DropdownMenuTrigger>
			</MediaPlayerTooltip>
			<DropdownMenuContent
				align="end"
				side="top"
				sideOffset={sideOffset}
				container={context.portalContainer}
				className="w-56 data-[side=top]:mb-3.5"
			>
				<DropdownMenuLabel className="sr-only">Settings</DropdownMenuLabel>
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<span className="flex-1">Speed</span>
						<Badge variant="outline" className="rounded-sm">
							{mediaPlaybackRate}x
						</Badge>
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						{speeds.map((speed) => (
							<DropdownMenuItem
								key={speed}
								className="justify-between"
								onSelect={() => onPlaybackRateChange(speed)}
							>
								{speed}x{mediaPlaybackRate === speed && <CheckIcon />}
							</DropdownMenuItem>
						))}
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				{enhancedAudioStatus === "COMPLETE" && (
					<DropdownMenuItem
						className="justify-between"
						onSelect={() => setEnhancedAudioEnabled?.(!enhancedAudioEnabled)}
					>
						<span className="flex items-center gap-2">
							<SparklesIcon className="size-4" />
							Enhanced Audio
						</span>
						{enhancedAudioEnabled && <CheckIcon />}
					</DropdownMenuItem>
				)}
				{context.isVideo && mediaRenditionList.length > 0 && (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<span className="flex-1">Quality</span>
							<Badge variant="outline" className="rounded-sm">
								{selectedRenditionLabel}
							</Badge>
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuItem
								className="justify-between"
								onSelect={() => onRenditionChange("auto")}
							>
								Auto
								{!selectedRenditionId && <CheckIcon />}
							</DropdownMenuItem>
							{mediaRenditionList
								.slice()
								.sort((a, b) => {
									const aHeight = a.height ?? 0;
									const bHeight = b.height ?? 0;
									return bHeight - aHeight;
								})
								.map((rendition) => {
									const label = rendition.height
										? `${rendition.height}p`
										: rendition.width
											? `${rendition.width}p`
											: (rendition.id ?? "Unknown");

									const selected = rendition.id === selectedRenditionId;

									return (
										<DropdownMenuItem
											key={rendition.id}
											className="justify-between"
											onSelect={() => onRenditionChange(rendition.id ?? "")}
										>
											{label}
											{selected && <CheckIcon />}
										</DropdownMenuItem>
									);
								})}
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

interface MediaPlayerPortalProps {
	container?: Element | DocumentFragment | null;
	children?: React.ReactNode;
}

function MediaPlayerPortal(props: MediaPlayerPortalProps) {
	const { container: containerProp, children } = props;

	const context = useMediaPlayerContext("MediaPlayerPortal");
	const container = containerProp ?? context.portalContainer;

	if (!container) return null;

	return ReactDOM.createPortal(children, container);
}

interface MediaPlayerTooltipProps
	extends React.ComponentProps<typeof Tooltip>,
		Pick<React.ComponentProps<typeof TooltipContent>, "sideOffset"> {
	tooltip?: string;
	shortcut?: string | string[];
}

function MediaPlayerTooltip(props: MediaPlayerTooltipProps) {
	const {
		tooltip,
		shortcut,
		delayDuration,
		sideOffset,
		children,
		...tooltipProps
	} = props;

	const context = useMediaPlayerContext("MediaPlayerTooltip");
	const tooltipDelayDuration = delayDuration ?? context.tooltipDelayDuration;
	const tooltipSideOffset = sideOffset ?? context.tooltipSideOffset;

	if ((!tooltip && !shortcut) || context.withoutTooltip) return <>{children}</>;

	return (
		<Tooltip {...tooltipProps} delayDuration={tooltipDelayDuration}>
			<TooltipTrigger
				className="text-foreground focus-visible:ring-ring/50"
				asChild
			>
				{children}
			</TooltipTrigger>
			<TooltipContent
				container={context.portalContainer}
				sideOffset={tooltipSideOffset}
				className="flex items-center gap-2 border bg-white px-2 py-1 font-medium text-black data-[side=top]:mb-3.5  [&>span]:hidden"
			>
				<p>{tooltip}</p>
				{Array.isArray(shortcut) ? (
					<div className="flex gap-1 items-center">
						{shortcut.map((shortcutKey) => (
							<kbd
								key={shortcutKey}
								className="select-none rounded border bg-white px-1.5 py-0.5 font-mono text-[11.2px] text-black shadow-xs"
							>
								<abbr title={shortcutKey} className="no-underline">
									{shortcutKey}
								</abbr>
							</kbd>
						))}
					</div>
				) : (
					shortcut && (
						<kbd
							key={shortcut}
							className="select-none rounded border bg-white px-1.5 py-px font-mono text-[11.2px] text-foreground shadow-xs"
						>
							<abbr title={shortcut} className="no-underline">
								{shortcut}
							</abbr>
						</kbd>
					)
				)}
			</TooltipContent>
		</Tooltip>
	);
}

export {
	MediaPlayerRoot as MediaPlayer,
	MediaPlayerVideo,
	MediaPlayerAudio,
	MediaPlayerControls,
	MediaPlayerControlsOverlay,
	MediaPlayerLoading,
	MediaPlayerError,
	MediaPlayerVolumeIndicator,
	MediaPlayerPlay,
	MediaPlayerSeekBackward,
	MediaPlayerSeekForward,
	MediaPlayerSeek,
	MediaPlayerVolume,
	MediaPlayerTime,
	MediaPlayerPlaybackSpeed,
	MediaPlayerLoop,
	MediaPlayerFullscreen,
	MediaPlayerPiP,
	MediaPlayerCaptions,
	MediaPlayerEnhancedAudio,
	MediaPlayerDownload,
	MediaPlayerSettings,
	MediaPlayerPortal,
	MediaPlayerTooltip,
	EnhancedAudioSync,
	MediaPlayerRoot as Root,
	MediaPlayerVideo as Video,
	MediaPlayerAudio as Audio,
	MediaPlayerControls as Controls,
	MediaPlayerControlsOverlay as ControlsOverlay,
	MediaPlayerLoading as Loading,
	MediaPlayerVolumeIndicator as VolumeIndicator,
	MediaPlayerError as Error,
	MediaPlayerPlay as Play,
	MediaPlayerSeekBackward as SeekBackward,
	MediaPlayerSeekForward as SeekForward,
	MediaPlayerSeek as Seek,
	MediaPlayerVolume as Volume,
	MediaPlayerTime as Time,
	MediaPlayerPlaybackSpeed as PlaybackSpeed,
	MediaPlayerLoop as Loop,
	MediaPlayerFullscreen as Fullscreen,
	MediaPlayerPiP as PiP,
	MediaPlayerCaptions as Captions,
	MediaPlayerEnhancedAudio as EnhancedAudio,
	MediaPlayerDownload as Download,
	MediaPlayerSettings as Settings,
	MediaPlayerPortal as Portal,
	MediaPlayerTooltip as Tooltip,
	useMediaSelector as useMediaPlayer,
	useStoreSelector as useMediaPlayerStore,
};
