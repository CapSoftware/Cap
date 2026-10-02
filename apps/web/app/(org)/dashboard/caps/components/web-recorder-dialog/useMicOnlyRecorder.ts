"use client";

import { acquireMicStream } from "@cap/recorder-core/capture-streams";
import type {
	RecorderPhase,
	RecordingFailureDownload,
} from "@cap/recorder-core/recorder-types";
import {
	canUseRecordingSpool,
	createRecordingSessionId,
	RECORDING_SPOOL_HEARTBEAT_INTERVAL_MS,
	RecordingSpool,
} from "@cap/recorder-core/recording-spool";
import { Organisation } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MAX_AUDIO_VIDEO_SECONDS } from "@/lib/audio-video-limits";
import { importMediaFile } from "../../../import/import-media";
import { useUploadingContext } from "../../UploadingContext";
import type { RecordingQuality } from "./recording-quality";
import {
	micOnlyFileExtension,
	micOnlyLanding,
	micOnlyMimeType,
} from "./recording-sources";
import { useRecordingTimer } from "./useRecordingTimer";
import { FREE_PLAN_MAX_RECORDING_MS } from "./web-recorder-constants";

// Wrapping the audio in its title-card video is a short step before upload.
const CONVERT_SHARE = 0.2;
// The upload is refused once its rounded duration passes the free limit, so
// a free take stops a second early to leave room for the encoder's tail.
const FREE_PLAN_STOP_AT_MS = FREE_PLAN_MAX_RECORDING_MS - 1000;
// The take is turned into a video to share, which caps its length.
const MAX_STOP_AT_MS = MAX_AUDIO_VIDEO_SECONDS * 1000 - 1000;

/**
 * Records just the microphone. The recording can't stream to storage like a
 * screen or camera take, since every Cap needs a video track: on stop it's
 * wrapped in a title-card video the way an imported audio file is, and
 * uploaded as an audio-only Cap. Until then the take is kept in memory and,
 * where the browser allows, in a local spool the recorder's recovery sweep
 * offers as a download if the tab dies.
 */
export function useMicOnlyRecorder({
	organisationId,
	selectedMicId,
	quality,
	isProUser,
	editorEnabled,
	beforeRecordingStarts,
	onRecordingStart,
	onRecordingStop,
}: {
	organisationId: string | undefined;
	selectedMicId: string | null;
	quality: RecordingQuality;
	isProUser: boolean;
	editorEnabled: boolean;
	beforeRecordingStarts?: () => Promise<boolean>;
	onRecordingStart?: () => void;
	onRecordingStop?: () => void;
}) {
	const router = useRouter();
	const { setUploadStatus } = useUploadingContext();
	const [phase, setPhase] = useState<RecorderPhase>("idle");
	const [isSettingUp, setIsSettingUp] = useState(false);
	const [videoId, setVideoId] = useState<string | null>(null);
	const [completedShareUrl, setCompletedShareUrl] = useState<string | null>(
		null,
	);
	const [errorDownload, setErrorDownload] =
		useState<RecordingFailureDownload | null>(null);
	const [saveProgress, setSaveProgress] = useState<number | null>(null);
	const [recordedBytes, setRecordedBytes] = useState(0);

	const {
		durationMs,
		clearTimer,
		startTimer,
		resetTimer,
		pauseTimer,
		resumeTimer,
		syncDurationFromClock,
	} = useRecordingTimer();

	const sessionRef = useRef(0);
	const streamRef = useRef<MediaStream | null>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const spoolRef = useRef<RecordingSpool | null>(null);
	const heartbeatRef = useRef<number | null>(null);
	const phaseRef = useRef(phase);
	phaseRef.current = phase;

	const stopHeartbeat = useCallback(() => {
		if (heartbeatRef.current === null) return;
		window.clearInterval(heartbeatRef.current);
		heartbeatRef.current = null;
	}, []);

	const releaseStream = useCallback(() => {
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
	}, []);

	const disposeSpool = useCallback(async () => {
		const spool = spoolRef.current;
		spoolRef.current = null;
		stopHeartbeat();
		await spool?.dispose().catch((error) => {
			console.error("Failed to dispose microphone recording spool", error);
		});
	}, [stopHeartbeat]);

	const replaceErrorDownload = useCallback(
		(next: RecordingFailureDownload | null) => {
			setErrorDownload((current) => {
				if (current) URL.revokeObjectURL(current.url);
				return next;
			});
		},
		[],
	);

	/** Throws the take away without saving it. */
	const discard = useCallback(async () => {
		sessionRef.current += 1;
		const recorder = recorderRef.current;
		recorderRef.current = null;
		if (recorder) {
			recorder.ondataavailable = null;
			if (recorder.state !== "inactive") {
				try {
					recorder.stop();
				} catch {}
			}
		}
		chunksRef.current = [];
		releaseStream();
		resetTimer();
		await disposeSpool();
		setRecordedBytes(0);
		setSaveProgress(null);
		setIsSettingUp(false);
		setPhase("idle");
	}, [disposeSpool, releaseStream, resetTimer]);

	const start = useCallback(async () => {
		if (!organisationId) {
			toast.error("Select an organization before recording.");
			return;
		}
		if (!selectedMicId) {
			toast.error("Select a microphone before recording.");
			return;
		}
		const session = ++sessionRef.current;
		replaceErrorDownload(null);
		setVideoId(null);
		setCompletedShareUrl(null);
		setRecordedBytes(0);
		setSaveProgress(null);
		setIsSettingUp(true);
		try {
			const mimeType =
				typeof MediaRecorder === "undefined"
					? undefined
					: micOnlyMimeType((type) => MediaRecorder.isTypeSupported(type));
			if (!mimeType) throw new Error("This browser can't record audio");
			const stream = await acquireMicStream(selectedMicId, quality.mic);
			streamRef.current = stream;
			if (session !== sessionRef.current) {
				releaseStream();
				return;
			}
			if (canUseRecordingSpool()) {
				try {
					const spool = await RecordingSpool.create({
						mimeType,
						sessionId: `${createRecordingSessionId()}-microphone`,
					});
					spoolRef.current = spool;
					heartbeatRef.current = window.setInterval(() => {
						if (spoolRef.current === spool) void spool.touch();
					}, RECORDING_SPOOL_HEARTBEAT_INTERVAL_MS);
				} catch (error) {
					console.error("Failed to create microphone recording spool", error);
				}
			}
			const go = await (beforeRecordingStarts?.() ?? Promise.resolve(true));
			if (!go || session !== sessionRef.current) {
				if (session === sessionRef.current) await discard();
				return;
			}
			const recorder = new MediaRecorder(stream, {
				mimeType,
				audioBitsPerSecond: 128_000,
			});
			chunksRef.current = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size === 0) return;
				chunksRef.current.push(event.data);
				setRecordedBytes((bytes) => bytes + event.data.size);
				const spool = spoolRef.current;
				spool?.appendChunk(event.data).catch((error: unknown) => {
					if (spoolRef.current !== spool) return;
					// The take is still whole in memory; a backup missing a chunk
					// would only offer a broken recovery later.
					console.error("Microphone backup write failed", error);
					spoolRef.current = null;
					stopHeartbeat();
					void spool.dispose().catch(() => undefined);
					toast.warning(
						"This recording is no longer backed up on this device. Keep this tab open until it saves.",
					);
				});
			};
			stream.getAudioTracks()[0]?.addEventListener("ended", () => {
				if (recorderRef.current === recorder) void stopRef.current?.();
			});
			recorderRef.current = recorder;
			recorder.start(1000);
			onRecordingStart?.();
			startTimer();
			setPhase("recording");
		} catch (error) {
			console.error("Failed to start microphone recording", error);
			if (session === sessionRef.current) {
				await discard();
				toast.error(
					error instanceof DOMException && error.name === "NotAllowedError"
						? "Your browser blocked the microphone. Allow it in the address bar, then try again."
						: "Couldn't start recording your microphone. Try again.",
				);
			}
		} finally {
			if (session === sessionRef.current) setIsSettingUp(false);
		}
	}, [
		organisationId,
		selectedMicId,
		quality.mic,
		beforeRecordingStarts,
		onRecordingStart,
		startTimer,
		discard,
		releaseStream,
		replaceErrorDownload,
		stopHeartbeat,
	]);

	const save = useCallback(
		async (blob: Blob, mimeType: string) => {
			if (!organisationId) throw new Error("No organization selected");
			const extension = micOnlyFileExtension(mimeType);
			const audio = new File([blob], `Audio recording.${extension}`, {
				type: mimeType,
			});
			setPhase("converting");
			setSaveProgress(0);
			const { wrapAudioInVideo } = await import("@/lib/audio-to-video");
			const video = await wrapAudioInVideo(audio, (fraction) =>
				setSaveProgress(fraction * CONVERT_SHARE),
			);
			setPhase("uploading");
			let createdId: string | null = null;
			const date = new Date();
			const ok = await importMediaFile({
				file: video,
				orgId: Organisation.OrganisationId.make(organisationId),
				name: `Cap Recording - ${date.getDate()} ${date.toLocaleString(
					"default",
					{ month: "long" },
				)} ${date.getFullYear()}`,
				audioOnly: true,
				quiet: true,
				openInEditor: editorEnabled,
				setUploadStatus: (status) => {
					setUploadStatus(status);
					if (status?.status === "uploadingVideo")
						setSaveProgress(
							CONVERT_SHARE + (1 - CONVERT_SHARE) * (status.progress / 100),
						);
				},
				onVideoCreated: (id) => {
					createdId = id;
					setVideoId(id);
				},
			});
			if (!ok || !createdId) throw new Error("The recording didn't upload");
			return createdId as string;
		},
		[organisationId, editorEnabled, setUploadStatus],
	);

	const stop = useCallback(async () => {
		const recorder = recorderRef.current;
		if (
			!recorder ||
			(phaseRef.current !== "recording" && phaseRef.current !== "paused")
		)
			return;
		const session = sessionRef.current;
		recorderRef.current = null;
		onRecordingStop?.();
		const stopped = new Promise<void>((resolve) =>
			recorder.addEventListener("stop", () => resolve(), { once: true }),
		);
		if (recorder.state !== "inactive") recorder.stop();
		await stopped;
		syncDurationFromClock();
		clearTimer();
		releaseStream();
		if (session !== sessionRef.current) return;
		const mimeType = recorder.mimeType || "audio/webm";
		const blob = new Blob(chunksRef.current, { type: mimeType });
		chunksRef.current = [];
		if (blob.size === 0) {
			await discard();
			toast.error("Nothing was recorded. Check your microphone and try again.");
			return;
		}
		try {
			const id = await save(blob, mimeType);
			if (session !== sessionRef.current) return;
			spoolRef.current?.markUploaded();
			void disposeSpool();
			const landing = micOnlyLanding(id, editorEnabled);
			try {
				router.push(landing);
			} catch (navigationError) {
				console.error("Failed to open the recording", navigationError);
				window.location.assign(landing);
			}
			setSaveProgress(null);
			setCompletedShareUrl(
				`${window.location.origin}/s/${encodeURIComponent(id)}`,
			);
			setPhase("completed");
		} catch (error) {
			console.error("Failed to save microphone recording", error);
			if (session !== sessionRef.current) return;
			// The spool stays, so reopening the recorder offers it again even
			// after this tab is gone.
			spoolRef.current = null;
			stopHeartbeat();
			setUploadStatus(undefined);
			setSaveProgress(null);
			replaceErrorDownload({
				url: URL.createObjectURL(blob),
				fileName: `cap-recording-${Date.now()}-microphone.${micOnlyFileExtension(mimeType)}`,
			});
			setPhase("error");
		}
	}, [
		onRecordingStop,
		syncDurationFromClock,
		clearTimer,
		releaseStream,
		discard,
		save,
		disposeSpool,
		editorEnabled,
		router,
		stopHeartbeat,
		setUploadStatus,
		replaceErrorDownload,
	]);
	const stopRef = useRef(stop);
	stopRef.current = stop;

	const pause = useCallback(() => {
		const recorder = recorderRef.current;
		if (phaseRef.current !== "recording" || recorder?.state !== "recording")
			return;
		try {
			const timestamp = performance.now();
			recorder.pause();
			pauseTimer(timestamp);
			setPhase("paused");
		} catch (error) {
			console.error("Failed to pause microphone recording", error);
			toast.error("Could not pause recording.");
		}
	}, [pauseTimer]);

	const resume = useCallback(() => {
		const recorder = recorderRef.current;
		if (phaseRef.current !== "paused" || recorder?.state !== "paused") return;
		try {
			const timestamp = performance.now();
			recorder.resume();
			resumeTimer(timestamp);
			setPhase("recording");
		} catch (error) {
			console.error("Failed to resume microphone recording", error);
			toast.error("Could not resume recording.");
		}
	}, [resumeTimer]);

	const [isRestarting, setIsRestarting] = useState(false);
	const restart = useCallback(async () => {
		if (phaseRef.current !== "recording" && phaseRef.current !== "paused")
			return;
		setIsRestarting(true);
		try {
			await discard();
			await start();
		} finally {
			setIsRestarting(false);
		}
	}, [discard, start]);

	const reset = useCallback(async () => {
		if (phaseRef.current === "converting" || phaseRef.current === "uploading")
			return;
		await discard();
		replaceErrorDownload(null);
		setVideoId(null);
		setCompletedShareUrl(null);
	}, [discard, replaceErrorDownload]);

	useEffect(() => {
		if (phase !== "recording" && phase !== "paused") return;
		if (durationMs < (isProUser ? MAX_STOP_AT_MS : FREE_PLAN_STOP_AT_MS))
			return;
		toast.info(
			isProUser
				? "Microphone recordings are limited to 4 hours. Recording stopped automatically."
				: "Free plan recordings are limited to 5 minutes. Recording stopped automatically.",
		);
		void stopRef.current();
	}, [durationMs, isProUser, phase]);

	useEffect(
		() => () => {
			sessionRef.current += 1;
			const recorder = recorderRef.current;
			if (recorder) {
				recorder.ondataavailable = null;
				if (recorder.state !== "inactive") {
					try {
						recorder.stop();
					} catch {}
				}
			}
			for (const track of streamRef.current?.getTracks() ?? []) track.stop();
			if (heartbeatRef.current !== null)
				window.clearInterval(heartbeatRef.current);
		},
		[],
	);

	const active = isSettingUp || phase !== "idle";
	return {
		active,
		phase,
		isSettingUp,
		isRestarting,
		isRecording: phase === "recording" || phase === "paused",
		isPaused: phase === "paused",
		isBusy:
			phase === "recording" ||
			phase === "paused" ||
			phase === "converting" ||
			phase === "uploading" ||
			isRestarting,
		durationMs,
		videoId,
		completedShareUrl,
		errorDownload,
		saveProgress,
		recordedBytes,
		start,
		stop,
		pause,
		resume,
		restart,
		reset,
	};
}
