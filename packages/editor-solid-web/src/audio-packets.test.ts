import { expect, test } from "bun:test";
import { parseEditorAudioPacket } from "./audio-packets";

function makePacket(magic = "CAPA", frames = 512) {
	const packet = new ArrayBuffer(20 + frames * 2 * 4);
	const header = new DataView(packet);
	for (let index = 0; index < 4; index++) {
		header.setUint8(index, magic.charCodeAt(index));
	}
	header.setUint32(4, 48_000, true);
	header.setUint16(8, 2, true);
	header.setUint16(10, frames, true);
	header.setBigUint64(12, 1_789_522_000_000_000_000n, true);
	new Float32Array(packet, 20)[0] = 0.25;
	return packet;
}

test("valid headless audio packets preserve samples and timing", () => {
	const packet = parseEditorAudioPacket(makePacket());
	expect(packet?.sampleRate).toBe(48_000);
	expect(packet?.channels).toBe(2);
	expect(packet?.frames).toBe(512);
	expect(packet?.samples[0]).toBe(0.25);
	expect(packet?.deadlineNs).toBe(1_789_522_000_000_000_000n);
});

test("audio packets reject malformed headers and lengths", () => {
	expect(parseEditorAudioPacket(makePacket("CAPE"))).toBeNull();
	expect(parseEditorAudioPacket(makePacket().slice(0, -1))).toBeNull();
	const oversized = makePacket("CAPA", 2049);
	expect(parseEditorAudioPacket(oversized)).toBeNull();
});
