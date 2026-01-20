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
import type { ProjectConfiguration } from "../types/project-config";
import { createDefaultConfig } from "../utils/defaults";
import { useHistory } from "./useHistory";

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
	history: {
		undo: () => void;
		redo: () => void;
		canUndo: boolean;
		canRedo: boolean;
	};
	waveformData: number[] | null;
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
	const [editorState, setEditorState] = useState<EditorState>(() => ({
		...DEFAULT_EDITOR_STATE,
		timeline: {
			...DEFAULT_EDITOR_STATE.timeline,
			transform: {
				position: 0,
				zoom: Math.min(video.duration, 30),
			},
		},
	}));

	const {
		state: project,
		set: setProjectInternal,
		undo,
		redo,
		canUndo,
		canRedo,
	} = useHistory(initialConfig ?? createDefaultConfig(video.duration));

	const [waveformData] = useState<number[] | null>(null);

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

	const play = useCallback(() => {
		videoRef.current?.play();
		setEditorState((state) => ({ ...state, playing: true }));
	}, []);

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

		let animationFrameId: number;

		const updatePlayhead = () => {
			if (videoRef.current) {
				const currentTime = videoRef.current.currentTime;
				setEditorState((state) => ({
					...state,
					playbackTime: currentTime,
				}));
			}
			animationFrameId = requestAnimationFrame(updatePlayhead);
		};

		animationFrameId = requestAnimationFrame(updatePlayhead);

		return () => cancelAnimationFrame(animationFrameId);
	}, [editorState.playing]);

	const value: EditorContextValue = {
		video,
		videoUrl,
		editorState,
		setEditorState,
		project,
		setProject: setProjectInternal,
		history: { undo, redo, canUndo, canRedo },
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
