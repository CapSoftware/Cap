import type { AudioConfiguration } from "../types/project-config";

const MIN_DB = -30;

function dbToGain(db: number): number {
	if (!Number.isFinite(db) || db <= MIN_DB) return 0;
	return 10 ** (db / 20);
}

export function getAudioPlaybackGain(audio: AudioConfiguration): number {
	if (audio.mute) return 0;

	const gains = [
		dbToGain(audio.micVolumeDb),
		dbToGain(audio.systemVolumeDb),
	].filter((gain) => gain > 0);

	if (gains.length === 0) return 0;

	return gains.reduce((sum, gain) => sum + gain, 0) / gains.length;
}
