"use client";

import type { Video } from "@cap/web-domain";
import { useTranscript } from "hooks/use-transcript";
import { useMemo } from "react";
import {
	envelopeFromVtt,
	parseVttCues,
	pseudoEnvelope,
	WAVEFORM_BUCKETS,
} from "./waveform-envelope";

interface UseTimelineWaveformOptions {
	videoId: Video.VideoId;
	transcriptionStatus?: string | null;
	duration: number;
}

/**
 * The filmstrip's amplitude envelope. Rides the transcript query the captions
 * path already runs (same react-query key, so this costs no extra request) and
 * falls back to a seeded shape when there is no transcript to read.
 */
export function useTimelineWaveform({
	videoId,
	transcriptionStatus,
	duration,
}: UseTimelineWaveformOptions): Float32Array | null {
	const { data } = useTranscript(videoId, transcriptionStatus);

	return useMemo(() => {
		if (!Number.isFinite(duration) || duration <= 0) return null;
		if (typeof data === "string" && parseVttCues(data).length > 0) {
			return envelopeFromVtt(data, duration, WAVEFORM_BUCKETS);
		}
		return pseudoEnvelope(videoId, duration, WAVEFORM_BUCKETS);
	}, [data, duration, videoId]);
}
