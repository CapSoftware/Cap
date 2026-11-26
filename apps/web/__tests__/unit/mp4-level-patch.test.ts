import { describe, expect, it, vi } from "vitest";
import {
	createLevelPatchedMp4ObjectUrl,
	isIosSafari,
	patchMp4AvcLevel,
	probeAvcFromUrl,
	probeAvcLevelFromUrl,
	readAvcFromMp4Prefix,
	readAvcLevelFromMp4Prefix,
	shouldPatchAvcLevelForIos,
} from "@/app/s/[videoId]/_components/mp4-level-patch";

type BuiltAvcCFixture = {
	bytes: Uint8Array;
	avcCLevelOffset: number;
	spsLevelOffset: number;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
};

function buildAvcCFixture(level: number): BuiltAvcCFixture {
	const prefix = [0x00, 0x00, 0x00, 0x30];
	const fourcc = [0x61, 0x76, 0x63, 0x43];
	const avcCHeader = [0x01, 0x64, 0x00, level, 0xff, 0xe1];

	const sps = [
		0x67,
		0x64,
		0x00,
		level,
		0xac,
		0xb2,
		0x00,
		0x80,
		0x11,
		0x7f,
		0xe0,
		0x00,
		0x02,
	];
	const spsLen = sps.length;
	const spsLenBytes = [(spsLen >> 8) & 0xff, spsLen & 0xff];

	const ppsCountAndLen = [0x01];
	const pps = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];
	const ppsLen = pps.length;
	const ppsLenBytes = [(ppsLen >> 8) & 0xff, ppsLen & 0xff];

	const flat = [
		...prefix,
		...fourcc,
		...avcCHeader,
		...spsLenBytes,
		...sps,
		...ppsCountAndLen,
		...ppsLenBytes,
		...pps,
		0x00,
		0x00,
		0x00,
		0x00,
	];

	const bytes = new Uint8Array(flat);
	const fourccStart = prefix.length;
	const payloadStart = fourccStart + fourcc.length;
	const avcCLevelOffset = payloadStart + 3;
	const spsStart = payloadStart + avcCHeader.length + spsLenBytes.length;
	const spsLevelOffset = spsStart + 3;

	return { bytes, avcCLevelOffset, spsLevelOffset };
}

describe("patchMp4AvcLevel", () => {
	it("rewrites both avcC level_idc and embedded SPS level_idc when source exceeds ceiling", () => {
		const { bytes, avcCLevelOffset, spsLevelOffset } = buildAvcCFixture(0x3d);
		const result = patchMp4AvcLevel(bytes);

		expect(result.patched).toBe(true);
		expect(result.originalLevel).toBe(0x3d);
		expect(bytes[avcCLevelOffset]).toBe(0x2a);
		expect(bytes[spsLevelOffset]).toBe(0x2a);
	});

	it("is a no-op when the level is already within iOS limits", () => {
		const { bytes, avcCLevelOffset } = buildAvcCFixture(0x2a);
		const result = patchMp4AvcLevel(bytes);

		expect(result.patched).toBe(false);
		expect(result.originalLevel).toBe(0x2a);
		expect(bytes[avcCLevelOffset]).toBe(0x2a);
	});

	it("respects custom ceiling and target parameters", () => {
		const { bytes, avcCLevelOffset, spsLevelOffset } = buildAvcCFixture(0x33);
		const result = patchMp4AvcLevel(bytes, {
			maxAllowedLevel: 0x29,
			targetLevel: 0x28,
		});

		expect(result.patched).toBe(true);
		expect(result.originalLevel).toBe(0x33);
		expect(bytes[avcCLevelOffset]).toBe(0x28);
		expect(bytes[spsLevelOffset]).toBe(0x28);
	});

	it("leaves buffers without avcC untouched", () => {
		const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
		const snapshot = Uint8Array.from(bytes);
		const result = patchMp4AvcLevel(bytes);

		expect(result.patched).toBe(false);
		expect(result.originalLevel).toBe(null);
		expect(bytes).toEqual(snapshot);
	});
});

describe("readAvcLevelFromMp4Prefix", () => {
	it("returns the observed AVCLevelIndication byte", () => {
		const { bytes } = buildAvcCFixture(0x3d);
		expect(readAvcLevelFromMp4Prefix(bytes)).toBe(0x3d);
	});

	it("returns null when avcC is not present in the slice", () => {
		const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
		expect(readAvcLevelFromMp4Prefix(bytes)).toBe(null);
	});
});

function buildSampleEntryFixture(
	level: number,
	width: number,
	height: number,
	fourcc = "avc1",
): Uint8Array {
	const { bytes: avcC } = buildAvcCFixture(level);
	const entry = new Uint8Array(86 + avcC.length);
	const view = new DataView(entry.buffer);
	view.setUint32(0, entry.length);
	entry.set(new TextEncoder().encode(fourcc), 4);
	view.setUint16(14, 1);
	view.setUint16(32, width);
	view.setUint16(34, height);
	entry.set(avcC, 86);
	return entry;
}

describe("readAvcFromMp4Prefix", () => {
	it("reads the level and the coded size from the avc1 sample entry", () => {
		expect(
			readAvcFromMp4Prefix(buildSampleEntryFixture(0x3c, 5120, 2880)),
		).toEqual({ level: 0x3c, width: 5120, height: 2880 });
	});

	it("reads avc3 sample entries", () => {
		expect(
			readAvcFromMp4Prefix(buildSampleEntryFixture(0x3e, 1920, 1080, "avc3")),
		).toEqual({ level: 0x3e, width: 1920, height: 1080 });
	});

	it("reports an unknown size when avcC is not directly inside a sample entry", () => {
		const { bytes } = buildAvcCFixture(0x3e);
		expect(readAvcFromMp4Prefix(bytes)).toEqual({
			level: 0x3e,
			width: null,
			height: null,
		});
	});
});

describe("shouldPatchAvcLevelForIos", () => {
	it("leaves levels at or below 5.2 alone", () => {
		expect(
			shouldPatchAvcLevelForIos({ level: 0x34, width: 3840, height: 2160 }),
		).toBe(false);
		expect(shouldPatchAvcLevelForIos(null)).toBe(false);
	});

	it("patches a stream labelled above 5.2 whose frames fit level 5.2", () => {
		expect(
			shouldPatchAvcLevelForIos({ level: 0x3e, width: 1920, height: 1080 }),
		).toBe(true);
		expect(
			shouldPatchAvcLevelForIos({ level: 0x3c, width: 4096, height: 2304 }),
		).toBe(true);
	});

	it("skips frames larger than level 5.2 allows", () => {
		expect(
			shouldPatchAvcLevelForIos({ level: 0x3c, width: 5120, height: 2880 }),
		).toBe(false);
		expect(
			shouldPatchAvcLevelForIos({ level: 0x3c, width: 4112, height: 2304 }),
		).toBe(false);
	});

	it("keeps today's behaviour when the size cannot be read", () => {
		expect(
			shouldPatchAvcLevelForIos({ level: 0x3e, width: null, height: null }),
		).toBe(true);
	});
});

describe("isIosSafari", () => {
	it("detects iPhone Safari user agents", () => {
		expect(
			isIosSafari(
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1",
			),
		).toBe(true);
	});

	it("returns false for Android Chrome", () => {
		expect(
			isIosSafari(
				"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
			),
		).toBe(false);
	});

	it("returns false for desktop Chrome", () => {
		expect(
			isIosSafari(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
			),
		).toBe(false);
	});
});

describe("probeAvcLevelFromUrl", () => {
	it("reads the level from a Range response", async () => {
		const { bytes } = buildAvcCFixture(0x3d);
		const fetchImpl = vi.fn(async () => {
			return new Response(toArrayBuffer(bytes), {
				status: 206,
				headers: { "content-range": `bytes 0-${bytes.byteLength - 1}/99999` },
			});
		}) as unknown as typeof fetch;

		const level = await probeAvcLevelFromUrl("https://example/video.mp4", {
			fetchImpl,
			rangeBytes: bytes.byteLength,
		});

		expect(level).toBe(0x3d);
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://example/video.mp4",
			expect.objectContaining({
				headers: { Range: `bytes=0-${bytes.byteLength - 1}` },
			}),
		);
	});

	it("returns null on network failure", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("network");
		}) as unknown as typeof fetch;

		const level = await probeAvcLevelFromUrl("https://example/video.mp4", {
			fetchImpl,
		});
		expect(level).toBe(null);
	});
});

describe("probeAvcFromUrl", () => {
	it("reads the level and frame size from the first bytes", async () => {
		const bytes = buildSampleEntryFixture(0x3c, 5120, 2880);
		const fetchImpl = vi.fn(async () => {
			return new Response(toArrayBuffer(bytes), { status: 206 });
		}) as unknown as typeof fetch;

		const probe = await probeAvcFromUrl("https://example/video.mp4", {
			fetchImpl,
			rangeBytes: bytes.byteLength,
		});

		expect(probe).toEqual({ level: 0x3c, width: 5120, height: 2880 });
		expect(shouldPatchAvcLevelForIos(probe)).toBe(false);
	});
});

describe("createLevelPatchedMp4ObjectUrl", () => {
	const originalCreateObjectURL = URL.createObjectURL;

	it("returns a patched object URL when the level is too high", async () => {
		const { bytes } = buildAvcCFixture(0x3d);
		const fetchImpl = vi.fn(async () => {
			return new Response(bytes.slice(), {
				status: 200,
				headers: { "content-type": "video/mp4" },
			});
		}) as unknown as typeof fetch;

		URL.createObjectURL = vi.fn(
			() => "blob:mock",
		) as typeof URL.createObjectURL;

		try {
			const result = await createLevelPatchedMp4ObjectUrl(
				"https://example/video.mp4",
				{ fetchImpl },
			);

			expect(result).not.toBeNull();
			expect(result?.patched).toBe(true);
			expect(result?.originalLevel).toBe(0x3d);
			expect(result?.objectUrl).toBe("blob:mock");
		} finally {
			URL.createObjectURL = originalCreateObjectURL;
		}
	});
});
