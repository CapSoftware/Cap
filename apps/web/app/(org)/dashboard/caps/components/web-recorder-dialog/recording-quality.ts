"use client";

import type { MicProcessing } from "@cap/recorder-core/capture-streams";
import { useCallback, useEffect, useState } from "react";

export type RecordingQuality = {
	screenHeight: 1080 | 1440 | 2160;
	frameRate: 30 | 60;
	cameraHeight: 720 | 1080;
	level: "standard" | "high";
	mic: MicProcessing;
};

export const DEFAULT_RECORDING_QUALITY: RecordingQuality = {
	screenHeight: 1080,
	frameRate: 30,
	cameraHeight: 1080,
	level: "standard",
	mic: {
		noiseSuppression: true,
		echoCancellation: true,
		autoGainControl: true,
	},
};

/** High quality spends about 60% more bitrate on every video track. */
export const qualityBitrateScale = (quality: RecordingQuality) =>
	quality.level === "high" ? 1.6 : 1;

const STORAGE_KEY = "cap-web-recorder-quality";

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
	allowed.includes(value as T) ? (value as T) : fallback;

export const useRecordingQuality = () => {
	const [quality, setQualityState] = useState<RecordingQuality>(
		DEFAULT_RECORDING_QUALITY,
	);

	useEffect(() => {
		try {
			const stored = JSON.parse(
				window.localStorage.getItem(STORAGE_KEY) ?? "null",
			) as Partial<RecordingQuality> | null;
			if (!stored) return;
			const defaults = DEFAULT_RECORDING_QUALITY;
			setQualityState({
				screenHeight: pick(
					stored.screenHeight,
					[1080, 1440, 2160] as const,
					defaults.screenHeight,
				),
				frameRate: pick(
					stored.frameRate,
					[30, 60] as const,
					defaults.frameRate,
				),
				cameraHeight: pick(
					stored.cameraHeight,
					[720, 1080] as const,
					defaults.cameraHeight,
				),
				level: pick(
					stored.level,
					["standard", "high"] as const,
					defaults.level,
				),
				mic: {
					noiseSuppression:
						stored.mic?.noiseSuppression ?? defaults.mic.noiseSuppression,
					echoCancellation:
						stored.mic?.echoCancellation ?? defaults.mic.echoCancellation,
					autoGainControl:
						stored.mic?.autoGainControl ?? defaults.mic.autoGainControl,
				},
			});
		} catch {
			/* defaults */
		}
	}, []);

	const setQuality = useCallback((update: Partial<RecordingQuality>) => {
		setQualityState((current) => {
			const next = { ...current, ...update };
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				/* remembered for this visit only */
			}
			return next;
		});
	}, []);

	return [quality, setQuality] as const;
};
