export const AVC_LEVEL_IOS_HARDWARE_CEILING = 0x34;
export const AVC_LEVEL_MOBILE_SAFE_TARGET = 0x2a;

const AVCC_FOURCC_A = 0x61;
const AVCC_FOURCC_V = 0x76;
const AVCC_FOURCC_C = 0x63;
const AVCC_FOURCC_UPPER_C = 0x43;

const AVC_PROBE_RANGE_BYTES = 256 * 1024;

export type PatchMp4AvcLevelResult = {
	patched: boolean;
	originalLevel: number | null;
};

export function patchMp4AvcLevel(
	bytes: Uint8Array,
	options?: {
		maxAllowedLevel?: number;
		targetLevel?: number;
	},
): PatchMp4AvcLevelResult {
	const maxAllowed = options?.maxAllowedLevel ?? AVC_LEVEL_IOS_HARDWARE_CEILING;
	const target = options?.targetLevel ?? AVC_LEVEL_MOBILE_SAFE_TARGET;

	let patched = false;
	let firstObservedLevel: number | null = null;

	for (let i = 0; i + 16 < bytes.length; i++) {
		if (
			bytes[i] !== AVCC_FOURCC_A ||
			bytes[i + 1] !== AVCC_FOURCC_V ||
			bytes[i + 2] !== AVCC_FOURCC_C ||
			bytes[i + 3] !== AVCC_FOURCC_UPPER_C
		) {
			continue;
		}

		const payloadStart = i + 4;
		const levelIndicationOffset = payloadStart + 3;

		if (levelIndicationOffset >= bytes.length) continue;

		if (bytes[payloadStart] !== 0x01) continue;

		const observed = bytes[levelIndicationOffset];
		if (observed === undefined) continue;
		if (firstObservedLevel === null) firstObservedLevel = observed;

		if (observed <= maxAllowed) {
			continue;
		}

		bytes[levelIndicationOffset] = target;
		patched = true;

		const numSpsByte = bytes[payloadStart + 5];
		if (numSpsByte === undefined) continue;
		const numSps = numSpsByte & 0x1f;
		let cursor = payloadStart + 6;

		for (let s = 0; s < numSps && cursor + 2 <= bytes.length; s++) {
			const hiByte = bytes[cursor];
			const loByte = bytes[cursor + 1];
			if (hiByte === undefined || loByte === undefined) break;
			const spsLen = (hiByte << 8) | loByte;
			cursor += 2;
			if (spsLen < 4 || cursor + spsLen > bytes.length) break;

			const spsLevelIdc = cursor + 3;
			const spsLevelByte = bytes[spsLevelIdc];
			if (spsLevelByte !== undefined && spsLevelByte > maxAllowed) {
				bytes[spsLevelIdc] = target;
			}

			cursor += spsLen;
		}
	}

	return { patched, originalLevel: firstObservedLevel };
}

export function readAvcLevelFromMp4Prefix(bytes: Uint8Array): number | null {
	for (let i = 0; i + 8 < bytes.length; i++) {
		if (
			bytes[i] === AVCC_FOURCC_A &&
			bytes[i + 1] === AVCC_FOURCC_V &&
			bytes[i + 2] === AVCC_FOURCC_C &&
			bytes[i + 3] === AVCC_FOURCC_UPPER_C &&
			bytes[i + 4] === 0x01
		) {
			const levelByte = bytes[i + 4 + 3];
			return typeof levelByte === "number" ? levelByte : null;
		}
	}
	return null;
}

export function isIosSafari(userAgent: string | undefined): boolean {
	if (!userAgent) return false;
	const ua = userAgent.toLowerCase();
	const isAppleMobile = /(iphone|ipod|ipad)/.test(ua);
	if (isAppleMobile) return true;

	if (typeof navigator === "undefined") return false;

	const navWithTouch = navigator as Navigator & { maxTouchPoints?: number };
	const maxTouch =
		typeof navWithTouch.maxTouchPoints === "number"
			? navWithTouch.maxTouchPoints
			: 0;

	return (
		maxTouch > 1 &&
		/macintosh/.test(ua) &&
		/safari/.test(ua) &&
		!/chrome|chromium|edg|opr|firefox/.test(ua)
	);
}

export async function probeAvcLevelFromUrl(
	url: string,
	options?: {
		fetchImpl?: typeof fetch;
		signal?: AbortSignal;
		rangeBytes?: number;
	},
): Promise<number | null> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const rangeEnd = (options?.rangeBytes ?? AVC_PROBE_RANGE_BYTES) - 1;

	try {
		const response = await fetchImpl(url, {
			headers: { Range: `bytes=0-${rangeEnd}` },
			signal: options?.signal,
		});

		if (!response.ok && response.status !== 206) {
			return null;
		}

		const buffer = new Uint8Array(await response.arrayBuffer());
		return readAvcLevelFromMp4Prefix(buffer);
	} catch {
		return null;
	}
}

export type PatchedMp4Blob = {
	objectUrl: string;
	size: number;
	patched: boolean;
	originalLevel: number | null;
};

export async function createLevelPatchedMp4ObjectUrl(
	url: string,
	options?: {
		fetchImpl?: typeof fetch;
		signal?: AbortSignal;
		maxAllowedLevel?: number;
		targetLevel?: number;
	},
): Promise<PatchedMp4Blob | null> {
	const fetchImpl = options?.fetchImpl ?? fetch;

	try {
		const response = await fetchImpl(url, { signal: options?.signal });
		if (!response.ok) return null;

		const arrayBuffer = await response.arrayBuffer();
		const bytes = new Uint8Array(arrayBuffer);
		const { patched, originalLevel } = patchMp4AvcLevel(bytes, {
			maxAllowedLevel: options?.maxAllowedLevel,
			targetLevel: options?.targetLevel,
		});

		const blob = new Blob([bytes], {
			type: response.headers.get("content-type") ?? "video/mp4",
		});

		return {
			objectUrl: URL.createObjectURL(blob),
			size: bytes.byteLength,
			patched,
			originalLevel,
		};
	} catch {
		return null;
	}
}
