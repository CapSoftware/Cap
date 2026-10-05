export type ImportedWaveform = {
	levels: Uint8Array[];
};

export function decodeImportedWaveform(encoded: string): ImportedWaveform {
	const binary = atob(encoded);
	const first = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		first[index] = binary.charCodeAt(index);
	}
	const levels = [first];
	let previous = first;
	while (previous.length > 1) {
		const next = new Uint8Array(Math.ceil(previous.length / 2));
		for (let index = 0; index < next.length; index++) {
			next[index] = Math.max(
				previous[index * 2] ?? 0,
				previous[index * 2 + 1] ?? 0,
			);
		}
		levels.push(next);
		previous = next;
	}
	return { levels };
}

export function waveformRangeMax(
	waveform: ImportedWaveform,
	start: number,
	end: number,
): number {
	const length = waveform.levels[0]?.length ?? 0;
	const first = Math.max(0, Math.min(length, Math.floor(start)));
	const last = Math.max(first + 1, Math.min(length, Math.ceil(end)));
	if (first >= length) return 0;
	let maximum = 0;
	let left = first;
	let right = last;
	for (let level = 0; left < right; level++) {
		const peaks = waveform.levels[level];
		if (left % 2 !== 0) {
			maximum = Math.max(maximum, peaks[left] ?? 0);
			left++;
		}
		if (right % 2 !== 0) {
			right--;
			maximum = Math.max(maximum, peaks[right] ?? 0);
		}
		left = Math.floor(left / 2);
		right = Math.floor(right / 2);
	}
	return maximum;
}
