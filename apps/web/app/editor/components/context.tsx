"use client";

import type React from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { DEFAULT_EDITOR_STATE, type EditorState } from "../types/editor-state";
import type { ProjectConfiguration } from "../types/project-config";
import { createDefaultConfig } from "../utils/defaults";
import {
	findNextSegmentIndex,
	findSegmentIndexAtTime,
} from "../utils/playback";
import {
	createEmptyWaveform,
	generateWaveformFromUrl,
	normalizePeaks,
	type WaveformData,
} from "../utils/waveform";
import { useHistory } from "./useHistory";
import { type SaveRender, useSaveRender } from "./useSaveRender";

interface PersistedEditorState {
	previewTime: number;
	timeline: {
		interactMode: "seek" | "split";
		transform: {
			position: number;
			zoom: number;
		};
	};
}

interface EditorProjectSyncPayload {
	videoId: string;
	tabId: string;
	updatedAt: string;
	config: ProjectConfiguration;
}

function getEditorStorageKey(videoId: string): string {
	return `cap-editor-state-${videoId}`;
}

function getEditorSyncStorageKey(videoId: string): string {
	return `cap-editor-sync-${videoId}`;
}

function loadPersistedState(videoId: string): PersistedEditorState | null {
	if (typeof window === "undefined") return null;
	try {
		const stored = localStorage.getItem(getEditorStorageKey(videoId));
		if (!stored) return null;
		return JSON.parse(stored) as PersistedEditorState;
	} catch {
		return null;
	}
}

function savePersistedState(
	videoId: string,
	state: PersistedEditorState,
): void {
	if (typeof window === "undefined") return;
	try {
		localStorage.setItem(getEditorStorageKey(videoId), JSON.stringify(state));
	} catch {}
}

function createTabId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function serializeProject(config: ProjectConfiguration): string {
	try {
		return JSON.stringify(config);
	} catch {
		return "";
	}
}

function isIncomingUpdateNewer(
	currentUpdatedAt: string | null,
	incomingUpdatedAt: string,
): boolean {
	if (!currentUpdatedAt) return true;
	if (currentUpdatedAt === incomingUpdatedAt) return false;

	const currentTime = Date.parse(currentUpdatedAt);
	const incomingTime = Date.parse(incomingUpdatedAt);

	if (!Number.isNaN(currentTime) && !Number.isNaN(incomingTime)) {
		return incomingTime > currentTime;
	}

	return incomingUpdatedAt > currentUpdatedAt;
}

interface VideoData {
	id: string;
	name: string;
	duration: number;
	width: number;
	height: number;
}

interface EditorContextValue {
	video: VideoData;
	videoUrl: string;
	cameraUrl: string | null;
	editorState: EditorState;
	setEditorState: React.Dispatch<React.SetStateAction<EditorState>>;
	project: ProjectConfiguration;
	projectUpdatedAt: string | null;
	setProject: (config: ProjectConfiguration) => void;
	setProjectWithoutHistory: (config: ProjectConfiguration) => void;
	syncProject: (config: ProjectConfiguration, updatedAt: string) => void;
	history: {
		undo: () => void;
		redo: () => void;
		canUndo: boolean;
		canRedo: boolean;
		startBatch: () => void;
		commitBatch: () => void;
		cancelBatch: () => void;
	};
	waveformData: WaveformData | null;
	videoRef: React.RefObject<HTMLVideoElement | null>;
	cameraVideoRef: React.RefObject<HTMLVideoElement | null>;
	actions: {
		play: () => void;
		pause: () => void;
		seekTo: (time: number) => void;
		togglePlayback: () => void;
	};
	saveRender: SaveRender;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditorContext() {
	const context = useContext(EditorContext);
	if (!context) {
		throw new Error("useEditorContext must be used within EditorProvider");
	}
	return context;
}

interface EditorProviderProps {
	children: React.ReactNode;
	video: VideoData;
	videoUrl: string;
	cameraUrl: string | null;
	initialConfig?: ProjectConfiguration;
	initialProjectUpdatedAt?: string | null;
}

export function EditorProvider({
	children,
	video,
	videoUrl,
	cameraUrl,
	initialConfig,
	initialProjectUpdatedAt,
}: EditorProviderProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const cameraVideoRef = useRef<HTMLVideoElement>(null);
	const [editorState, setEditorState] = useState<EditorState>(() => {
		const defaultZoom = Math.max(2, Math.min(video.duration, 30));
		return {
			...DEFAULT_EDITOR_STATE,
			timeline: {
				...DEFAULT_EDITOR_STATE.timeline,
				transform: {
					position: 0,
					zoom: defaultZoom,
				},
			},
		};
	});

	const initialProject = initialConfig ?? createDefaultConfig(video.duration);

	const {
		state: project,
		set: setProjectInternal,
		setWithoutHistory: setProjectWithoutHistoryInternal,
		undo,
		redo,
		canUndo,
		canRedo,
		startBatch,
		commitBatch,
		cancelBatch,
	} = useHistory(initialProject);

	const [projectUpdatedAt, setProjectUpdatedAtState] = useState<string | null>(
		initialProjectUpdatedAt ?? null,
	);
	const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
	const initialTimeRef = useRef(0);
	const hasRestoredTimeRef = useRef(false);
	const loadedPersistedForVideoIdRef = useRef<string | null>(null);
	const projectUpdatedAtRef = useRef<string | null>(initialProjectUpdatedAt ?? null);
	const projectSerializedRef = useRef<string>(serializeProject(initialProject));
	const skipNextProjectSaveRef = useRef(true);
	const tabIdRef = useRef(createTabId());

	const setProjectUpdatedAt = useCallback((updatedAt: string | null) => {
		projectUpdatedAtRef.current = updatedAt;
		setProjectUpdatedAtState(updatedAt);
	}, []);

	const applySyncedProject = useCallback(
		(config: ProjectConfiguration, updatedAt: string) => {
			skipNextProjectSaveRef.current = true;
			projectSerializedRef.current = serializeProject(config);
			setProjectWithoutHistoryInternal(config);
			setProjectUpdatedAt(updatedAt);
		},
		[setProjectUpdatedAt, setProjectWithoutHistoryInternal],
	);

	const broadcastProjectSync = useCallback(
		(config: ProjectConfiguration, updatedAt: string) => {
			if (typeof window === "undefined") return;
			const syncKey = getEditorSyncStorageKey(video.id);
			const payload = JSON.stringify({
				videoId: video.id,
				tabId: tabIdRef.current,
				updatedAt,
				config,
			} as EditorProjectSyncPayload);

			try {
				localStorage.setItem(syncKey, payload);
				localStorage.removeItem(syncKey);
			} catch {}
		},
		[video.id],
	);

	const getExpectedUpdatedAt = useCallback(() => {
		return projectUpdatedAtRef.current;
	}, []);

	const handleSaveRenderProjectSaved = useCallback(
		(savedConfig: ProjectConfiguration, updatedAt: string) => {
			const currentUpdatedAt = projectUpdatedAtRef.current;
			if (
				!isIncomingUpdateNewer(currentUpdatedAt, updatedAt) &&
				currentUpdatedAt !== updatedAt
			) {
				return;
			}
			projectSerializedRef.current = serializeProject(savedConfig);
			setProjectUpdatedAt(updatedAt);
			broadcastProjectSync(savedConfig, updatedAt);
		},
		[broadcastProjectSync, setProjectUpdatedAt],
	);

	const handleSaveRenderProjectConflict = useCallback(
		(latestConfig: ProjectConfiguration, updatedAt: string) => {
			applySyncedProject(latestConfig, updatedAt);
			toast.error("This tab synced to newer changes from another tab.");
		},
		[applySyncedProject],
	);

	const saveRender = useSaveRender(video.id, {
		getExpectedUpdatedAt,
		onProjectSaved: handleSaveRenderProjectSaved,
		onProjectConflict: handleSaveRenderProjectConflict,
	});

	useEffect(() => {
		projectSerializedRef.current = serializeProject(project);
	}, [project]);

	useEffect(() => {
		skipNextProjectSaveRef.current = true;
		setProjectUpdatedAt(initialProjectUpdatedAt ?? null);
	}, [initialProjectUpdatedAt, setProjectUpdatedAt, video.id]);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const syncKey = getEditorSyncStorageKey(video.id);

		const onStorage = (event: StorageEvent) => {
			if (event.key !== syncKey || !event.newValue) return;
			try {
				const payload = JSON.parse(event.newValue) as Partial<EditorProjectSyncPayload>;
				if (payload.videoId !== video.id) return;
				if (payload.tabId === tabIdRef.current) return;
				if (typeof payload.updatedAt !== "string") return;
				if (!payload.config) return;

				const incomingConfig = payload.config as ProjectConfiguration;
				const incomingSerialized = serializeProject(incomingConfig);
				const currentUpdatedAt = projectUpdatedAtRef.current;
				const isNewer = isIncomingUpdateNewer(
					currentUpdatedAt,
					payload.updatedAt,
				);

				if (!isNewer) {
					if (
						currentUpdatedAt !== payload.updatedAt ||
						incomingSerialized === projectSerializedRef.current
					) {
						return;
					}
				}

				applySyncedProject(incomingConfig, payload.updatedAt);
			} catch {}
		};

		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener("storage", onStorage);
		};
	}, [applySyncedProject, video.id]);

	useEffect(() => {
		if (loadedPersistedForVideoIdRef.current === video.id) return;
		loadedPersistedForVideoIdRef.current = video.id;
		hasRestoredTimeRef.current = false;
		initialTimeRef.current = 0;

		const persisted = loadPersistedState(video.id);
		if (!persisted) return;

		const time = Math.min(persisted.previewTime, video.duration);
		initialTimeRef.current = time;

		setEditorState((state) => ({
			...state,
			previewTime: time,
			playbackTime: time,
			timeline: {
				...state.timeline,
				interactMode: persisted.timeline.interactMode,
				transform: {
					position: persisted.timeline.transform.position,
					zoom: persisted.timeline.transform.zoom,
				},
			},
		}));
	}, [video.id, video.duration]);

	useEffect(() => {
		let cancelled = false;

		generateWaveformFromUrl(videoUrl)
			.then((data) => {
				if (cancelled) return;
				setWaveformData({
					...data,
					peaks: normalizePeaks(data.peaks),
				});
			})
			.catch(() => {
				if (cancelled) return;
				setWaveformData(createEmptyWaveform(video.duration));
			});

		return () => {
			cancelled = true;
		};
	}, [videoUrl, video.duration]);

	useEffect(() => {
		if (hasRestoredTimeRef.current) return;
		if (!videoRef.current) return;
		const initialTime = initialTimeRef.current;
		if (initialTime > 0) {
			videoRef.current.currentTime = initialTime;
			hasRestoredTimeRef.current = true;
		}
	});

	useEffect(() => {
		if (skipNextProjectSaveRef.current) {
			skipNextProjectSaveRef.current = false;
			return;
		}

		const saveTimeout = window.setTimeout(() => {
			fetch(`/api/editor/${video.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					config: project,
					expectedUpdatedAt: projectUpdatedAtRef.current,
				}),
			})
				.then(async (response) => {
					const data = (await response.json().catch(() => null)) as
						| {
							code?: string;
							config?: ProjectConfiguration;
							updatedAt?: string;
						}
						| null;

					if (!response.ok) {
						if (
							response.status === 409 &&
							data?.code === "CONFIG_CONFLICT" &&
							data.config &&
							typeof data.updatedAt === "string"
						) {
							applySyncedProject(data.config, data.updatedAt);
							toast.error("This tab synced to newer changes from another tab.");
						}
						return;
					}

					if (!data || typeof data.updatedAt !== "string") return;
					const currentUpdatedAt = projectUpdatedAtRef.current;
					if (
						!isIncomingUpdateNewer(currentUpdatedAt, data.updatedAt) &&
						currentUpdatedAt !== data.updatedAt
					) {
						return;
					}

					projectSerializedRef.current = serializeProject(project);
					setProjectUpdatedAt(data.updatedAt);
					broadcastProjectSync(project, data.updatedAt);
				})
				.catch(() => undefined);
		}, 1000);

		return () => window.clearTimeout(saveTimeout);
	}, [
		applySyncedProject,
		broadcastProjectSync,
		project,
		setProjectUpdatedAt,
		video.id,
	]);

	useEffect(() => {
		const saveTimeout = window.setTimeout(() => {
			savePersistedState(video.id, {
				previewTime: editorState.previewTime,
				timeline: {
					interactMode: editorState.timeline.interactMode,
					transform: editorState.timeline.transform,
				},
			});
		}, 500);

		return () => window.clearTimeout(saveTimeout);
	}, [
		video.id,
		editorState.previewTime,
		editorState.timeline.interactMode,
		editorState.timeline.transform,
	]);

	const play = useCallback(() => {
		if (!videoRef.current) return;

		const segments = project.timeline?.segments ?? [
			{ start: 0, end: video.duration, timescale: 1 },
		];
		const currentTime = videoRef.current.currentTime;

		const currentSegmentIndex = findSegmentIndexAtTime(segments, currentTime);
		if (currentSegmentIndex === -1) {
			const nextSegmentIndex = findNextSegmentIndex(segments, currentTime);
			if (nextSegmentIndex !== -1) {
				const nextSegment = segments[nextSegmentIndex];
				if (nextSegment) {
					videoRef.current.currentTime = nextSegment.start;
				}
			} else {
				const firstSegment = segments[0];
				if (firstSegment) {
					videoRef.current.currentTime = firstSegment.start;
				}
			}
		}

		videoRef.current.play().catch(() => {
			setEditorState((state) => ({ ...state, playing: false }));
		});
		if (cameraVideoRef.current) {
			cameraVideoRef.current.currentTime = videoRef.current.currentTime;
			cameraVideoRef.current.play().catch(() => {});
		}
		setEditorState((state) => ({ ...state, playing: true }));
	}, [project.timeline?.segments, video.duration]);

	const pause = useCallback(() => {
		videoRef.current?.pause();
		cameraVideoRef.current?.pause();
		setEditorState((state) => ({ ...state, playing: false }));
	}, []);

	const seekTo = useCallback((time: number) => {
		if (videoRef.current) {
			videoRef.current.currentTime = time;
		}
		if (cameraVideoRef.current) {
			cameraVideoRef.current.currentTime = time;
		}
		setEditorState((state) => ({
			...state,
			playbackTime: time,
			previewTime: time,
		}));
	}, []);

	const togglePlayback = useCallback(() => {
		if (editorState.playing) {
			pause();
		} else {
			play();
		}
	}, [editorState.playing, pause, play]);

	useEffect(() => {
		if (!editorState.playing) return;

		const segments = project.timeline?.segments ?? [
			{ start: 0, end: video.duration, timescale: 1 },
		];
		let animationFrameId: number;

		const syncCamera = (time: number) => {
			const cam = cameraVideoRef.current;
			if (!cam) return;
			if (Math.abs(cam.currentTime - time) > 0.1) {
				cam.currentTime = time;
			}
		};

		const updatePlayhead = () => {
			if (videoRef.current) {
				const currentTime = videoRef.current.currentTime;
				const currentSegmentIndex = findSegmentIndexAtTime(
					segments,
					currentTime,
				);
				const lastSegment = segments[segments.length - 1];
				const endTime = lastSegment?.end ?? video.duration;

				if (currentSegmentIndex !== -1) {
					const currentSegment = segments[currentSegmentIndex];
					if (currentSegment && currentTime >= currentSegment.end - 0.001) {
						const nextSegment = segments[currentSegmentIndex + 1];
						if (nextSegment) {
							videoRef.current.currentTime = nextSegment.start;
							syncCamera(nextSegment.start);
						} else {
							videoRef.current.pause();
							cameraVideoRef.current?.pause();
							setEditorState((state) => ({
								...state,
								playing: false,
								playbackTime: endTime,
							}));
							return;
						}
					}
				} else {
					const nextSegmentIndex = findNextSegmentIndex(segments, currentTime);
					const nextSegment =
						nextSegmentIndex === -1 ? null : segments[nextSegmentIndex];
					if (nextSegment) {
						videoRef.current.currentTime = nextSegment.start;
						syncCamera(nextSegment.start);
					} else {
						videoRef.current.pause();
						cameraVideoRef.current?.pause();
						setEditorState((state) => ({
							...state,
							playing: false,
							playbackTime: endTime,
						}));
						return;
					}
				}

				syncCamera(videoRef.current.currentTime);

				setEditorState((state) => ({
					...state,
					playbackTime: videoRef.current?.currentTime ?? currentTime,
				}));
			}
			animationFrameId = requestAnimationFrame(updatePlayhead);
		};

		animationFrameId = requestAnimationFrame(updatePlayhead);

		return () => cancelAnimationFrame(animationFrameId);
	}, [editorState.playing, project.timeline?.segments, video.duration]);

	const value: EditorContextValue = {
		video,
		videoUrl,
		cameraUrl,
		editorState,
		setEditorState,
		project,
		projectUpdatedAt,
		setProject: setProjectInternal,
		setProjectWithoutHistory: setProjectWithoutHistoryInternal,
		syncProject: applySyncedProject,
		history: {
			undo,
			redo,
			canUndo,
			canRedo,
			startBatch,
			commitBatch,
			cancelBatch,
		},
		waveformData,
		videoRef,
		cameraVideoRef,
		actions: {
			play,
			pause,
			seekTo,
			togglePlayback,
		},
		saveRender,
	};

	return (
		<EditorContext.Provider value={value}>{children}</EditorContext.Provider>
	);
}
