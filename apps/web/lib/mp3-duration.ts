const LAYER_3 = 0b01;
const MPEG_1 = 0b11;
const MPEG_2 = 0b10;
const MPEG_2_5 = 0b00;

const BITRATES_MPEG_1 = [
	0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const BITRATES_MPEG_2 = [
	0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

const SAMPLE_RATES: Record<number, readonly number[]> = {
	[MPEG_1]: [44_100, 48_000, 32_000],
	[MPEG_2]: [22_050, 24_000, 16_000],
	[MPEG_2_5]: [11_025, 12_000, 8_000],
};

type Mp3Frame = {
	length: number;
	samples: number;
	sampleRate: number;
	sideInfoBytes: number;
};

function readFrame(bytes: Uint8Array, offset: number): Mp3Frame | null {
	if (offset + 4 > bytes.length) return null;
	const b0 = bytes[offset] ?? 0;
	const b1 = bytes[offset + 1] ?? 0;
	const b2 = bytes[offset + 2] ?? 0;
	const b3 = bytes[offset + 3] ?? 0;
	if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

	const version = (b1 >> 3) & 0b11;
	const layer = (b1 >> 1) & 0b11;
	if (layer !== LAYER_3) return null;
	const sampleRate = SAMPLE_RATES[version]?.[(b2 >> 2) & 0b11];
	if (!sampleRate) return null;

	const isMpeg1 = version === MPEG_1;
	const bitrate = (isMpeg1 ? BITRATES_MPEG_1 : BITRATES_MPEG_2)[b2 >> 4];
	if (!bitrate) return null;

	const padding = (b2 >> 1) & 1;
	const mono = b3 >> 6 === 0b11;
	return {
		length:
			Math.floor(((isMpeg1 ? 144_000 : 72_000) * bitrate) / sampleRate) +
			padding,
		samples: isMpeg1 ? 1152 : 576,
		sampleRate,
		sideInfoBytes: isMpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17,
	};
}

function id3v2Length(bytes: Uint8Array) {
	if (
		bytes.length < 10 ||
		bytes[0] !== 0x49 ||
		bytes[1] !== 0x44 ||
		bytes[2] !== 0x33
	) {
		return 0;
	}
	const size =
		(((bytes[6] ?? 0) & 0x7f) << 21) |
		(((bytes[7] ?? 0) & 0x7f) << 14) |
		(((bytes[8] ?? 0) & 0x7f) << 7) |
		((bytes[9] ?? 0) & 0x7f);
	const footer = ((bytes[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
	return 10 + size + footer;
}

function isInfoFrame(bytes: Uint8Array, offset: number, frame: Mp3Frame) {
	const tag = offset + 4 + frame.sideInfoBytes;
	if (tag + 4 > bytes.length) return false;
	const name = String.fromCharCode(
		bytes[tag] ?? 0,
		bytes[tag + 1] ?? 0,
		bytes[tag + 2] ?? 0,
		bytes[tag + 3] ?? 0,
	);
	return name === "Xing" || name === "Info";
}

export function measureMp3DurationSeconds(bytes: Uint8Array): number | null {
	let offset = id3v2Length(bytes);
	let seconds = 0;
	let frames = 0;
	let synced = false;

	while (offset + 4 <= bytes.length) {
		const frame = readFrame(bytes, offset);
		if (!frame) {
			synced = false;
			offset += 1;
			continue;
		}
		if (!synced) {
			const end = offset + frame.length;
			const confirmed =
				end + 4 > bytes.length || readFrame(bytes, end) !== null;
			if (!confirmed) {
				offset += 1;
				continue;
			}
		}
		if (!(frames === 0 && isInfoFrame(bytes, offset, frame))) {
			seconds += frame.samples / frame.sampleRate;
		}
		frames += 1;
		synced = true;
		offset += frame.length;
	}

	return frames > 0 && seconds > 0 ? seconds : null;
}
