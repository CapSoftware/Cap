"use client";

import { useCallback, useEffect } from "react";
import { splitSegmentAtSourceTime } from "../utils/timeline";
import { useEditorContext } from "./context";

const FRAME_DURATION = 1 / 30;
const SKIP_DURATION = 5;

function isInputElement(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	);
}

export function useEditorShortcuts() {
	const {
		actions,
		editorState,
		history,
		video,
		setEditorState,
		project,
		setProject,
	} = useEditorContext();

	const deleteSelectedSegments = useCallback(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.indices.length === 0) return;
		if (!project.timeline?.segments) return;

		const indicesToDelete = new Set(selection.indices);
		const newSegments = project.timeline.segments.filter(
			(_, index) => !indicesToDelete.has(index),
		);

		if (newSegments.length === 0) return;

		setProject({
			...project,
			timeline: {
				...project.timeline,
				segments: newSegments,
			},
		});

		setEditorState((state) => ({
			...state,
			timeline: {
				...state.timeline,
				selection: null,
			},
		}));
	}, [editorState.timeline.selection, project, setProject, setEditorState]);

	const splitAtPlayhead = useCallback(() => {
		if (!project.timeline?.segments) return;

		const result = splitSegmentAtSourceTime(
			project.timeline.segments,
			editorState.playbackTime,
		);
		if (!result) return;

		setProject({
			...project,
			timeline: {
				...project.timeline,
				segments: result.segments,
			},
		});

		setEditorState((state) => ({
			...state,
			timeline: {
				...state.timeline,
				selection: { type: "clip", indices: [result.selectionIndex] },
			},
		}));
	}, [editorState.playbackTime, project, setProject, setEditorState]);

	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (isInputElement(e.target)) return;

			const isMod = e.metaKey || e.ctrlKey;

			if (e.key === " ") {
				e.preventDefault();
				actions.togglePlayback();
				return;
			}

			if (e.key === "Home" || (e.key === "ArrowLeft" && isMod)) {
				e.preventDefault();
				actions.seekTo(0);
				return;
			}

			if (e.key === "End" || (e.key === "ArrowRight" && isMod)) {
				e.preventDefault();
				actions.seekTo(video.duration);
				return;
			}

			if (e.key === "ArrowLeft" && !isMod) {
				e.preventDefault();
				const step = e.shiftKey ? SKIP_DURATION : FRAME_DURATION;
				actions.seekTo(Math.max(0, editorState.playbackTime - step));
				return;
			}

			if (e.key === "ArrowRight" && !isMod) {
				e.preventDefault();
				const step = e.shiftKey ? SKIP_DURATION : FRAME_DURATION;
				actions.seekTo(
					Math.min(video.duration, editorState.playbackTime + step),
				);
				return;
			}

			if (e.key === "z" && isMod && !e.shiftKey) {
				e.preventDefault();
				if (history.canUndo) history.undo();
				return;
			}

			if ((e.key === "z" && isMod && e.shiftKey) || (e.key === "y" && isMod)) {
				e.preventDefault();
				if (history.canRedo) history.redo();
				return;
			}

			if (e.key === "Delete" || e.key === "Backspace") {
				if (editorState.timeline.selection) {
					e.preventDefault();
					deleteSelectedSegments();
				}
				return;
			}

			if ((e.key === "s" || e.key === "c") && !isMod) {
				e.preventDefault();
				splitAtPlayhead();
				return;
			}

			if (e.key === "Escape") {
				e.preventDefault();
				setEditorState((state) => ({
					...state,
					timeline: {
						...state.timeline,
						selection: null,
					},
				}));
				return;
			}
		}

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		actions,
		editorState.playbackTime,
		editorState.timeline.selection,
		history,
		video.duration,
		deleteSelectedSegments,
		splitAtPlayhead,
		setEditorState,
	]);
}
