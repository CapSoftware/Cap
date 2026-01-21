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
import { DEFAULT_EDITOR_STATE, type EditorState } from "../types/editor-state";
import type {
	ProjectConfiguration,
	TimelineSegment,
} from "../types/project-config";
import { createDefaultConfig } from "../utils/defaults";
import {
	generateWaveformFromUrl,
	normalizePeaks,
	type WaveformData,
} from "../utils/waveform";
import { useHistory } from "./useHistory";

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

function getEditorStorageKey(videoId: string): string {
	return `cap-editor-state-${videoId}`;
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

function findSegmentAtTime(
	segments: TimelineSegment[],
	time: number,
): TimelineSegment | null {
	for (const segment of segments) {
		if (time >= segment.start && time < segment.end) {
			return segment;
		}
	}
	return null;
}

function findNextSegment(
	segments: TimelineSegment[],
	time: number,
): TimelineSegment | null {
	const sortedSegments = [...segments].sort((a, b) => a.start - b.start);
	for (const segment of sortedSegments) {
		if (segment.start > time) {
			return segment;
		}
	}
	return null;
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
	editorState: EditorState;
	setEditorState: React.Dispatch<React.SetStateAction<EditorState>>;
	project: ProjectConfiguration;
	setProject: (config: ProjectConfiguration) => void;
	setProjectWithoutHistory: (config: ProjectConfiguration) => void;
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
	actions: {
		play: () => void;
		pause: () => void;
		seekTo: (time: number) => void;
		togglePlayback: () => void;
	};
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
	initialConfig?: ProjectConfiguration;
}

export function EditorProvider({
	children,
	video,
	videoUrl,
	initialConfig,
}: EditorProviderProps) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [editorState, setEditorState] = useState<EditorState>(() => {
		const persisted = loadPersistedState(video.id);
		const defaultZoom = Math.max(2, Math.min(video.duration, 30));
		if (persisted) {
			return {
				...DEFAULT_EDITOR_STATE,
				previewTime: Math.min(persisted.previewTime, video.duration),
				playbackTime: Math.min(persisted.previewTime, video.duration),
				timeline: {
					...DEFAULT_EDITOR_STATE.timeline,
					interactMode: persisted.timeline.interactMode,
					transform: {
						position: persisted.timeline.transform.position,
						zoom: persisted.timeline.transform.zoom,
					},
				},
			};
		}
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
	} = useHistory(initialConfig ?? createDefaultConfig(video.duration));

	const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
	const initialTimeRef = useRef(editorState.previewTime);
	const hasRestoredTimeRef = useRef(false);

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
			.catch(() => undefined);

		return () => {
			cancelled = true;
		};
	}, [videoUrl]);

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
		const saveTimeout = window.setTimeout(() => {
			fetch(`/api/editor/${video.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ config: project }),
			}).catch(() => undefined);
		}, 1000);

		return () => window.clearTimeout(saveTimeout);
	}, [project, video.id]);

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
		const sortedSegments = [...segments].sort((a, b) => a.start - b.start);
		const currentTime = videoRef.current.currentTime;

		const currentSegment = findSegmentAtTime(sortedSegments, currentTime);
		if (!currentSegment) {
			const nextSegment = findNextSegment(sortedSegments, currentTime);
			if (nextSegment) {
				videoRef.current.currentTime = nextSegment.start;
			} else {
				const firstSegment = sortedSegments[0];
				if (firstSegment) {
					videoRef.current.currentTime = firstSegment.start;
				}
			}
		}

		videoRef.current.play();
		setEditorState((state) => ({ ...state, playing: true }));
	}, [project.timeline?.segments, video.duration]);

	const pause = useCallback(() => {
		videoRef.current?.pause();
		setEditorState((state) => ({ ...state, playing: false }));
	}, []);

	const seekTo = useCallback((time: number) => {
		if (videoRef.current) {
			videoRef.current.currentTime = time;
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
		const sortedSegments = [...segments].sort((a, b) => a.start - b.start);
		let animationFrameId: number;

		const updatePlayhead = () => {
			if (videoRef.current) {
				const currentTime = videoRef.current.currentTime;

				const currentSegment = findSegmentAtTime(sortedSegments, currentTime);
				const lastSegment = sortedSegments[sortedSegments.length - 1];
				const endTime = lastSegment?.end ?? video.duration;

				if (currentSegment) {
					if (currentTime >= currentSegment.end) {
						const nextSegment = findNextSegment(sortedSegments, currentTime);
						if (nextSegment) {
							videoRef.current.currentTime = nextSegment.start;
						} else {
							videoRef.current.pause();
							setEditorState((state) => ({
								...state,
								playing: false,
								playbackTime: endTime,
							}));
							return;
						}
					}
				} else {
					const nextSegment = findNextSegment(sortedSegments, currentTime);
					if (nextSegment) {
						videoRef.current.currentTime = nextSegment.start;
					} else {
						videoRef.current.pause();
						setEditorState((state) => ({
							...state,
							playing: false,
							playbackTime: endTime,
						}));
						return;
					}
				}

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
		editorState,
		setEditorState,
		project,
		setProject: setProjectInternal,
		setProjectWithoutHistory: setProjectWithoutHistoryInternal,
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
		actions: {
			play,
			pause,
			seekTo,
			togglePlayback,
		},
	};

	return (
		<EditorContext.Provider value={value}>{children}</EditorContext.Provider>
	);
}
