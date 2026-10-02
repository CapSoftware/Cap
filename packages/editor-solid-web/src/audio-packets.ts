export type EditorAudioPacket = {
	sampleRate: number;
	channels: number;
	frames: number;
	deadlineNs: bigint;
	samples: Float32Array;
};

export function parseEditorAudioPacket(packet: ArrayBuffer) {
	if (packet.byteLength < 20 || (packet.byteLength - 20) % 4 !== 0) return null;
	const marker = new Uint8Array(packet, 0, 4);
	if (
		marker[0] !== 67 ||
		marker[1] !== 65 ||
		marker[2] !== 80 ||
		marker[3] !== 65
	)
		return null;
	const view = new DataView(packet);
	const sampleRate = view.getUint32(4, true);
	const channels = view.getUint16(8, true);
	const frames = view.getUint16(10, true);
	const deadlineNs = view.getBigUint64(12, true);
	if (
		sampleRate !== 48_000 ||
		channels !== 2 ||
		frames === 0 ||
		frames > 2048 ||
		packet.byteLength !== 20 + frames * channels * 4
	)
		return null;
	return {
		sampleRate,
		channels,
		frames,
		deadlineNs,
		samples: new Float32Array(packet, 20),
	} satisfies EditorAudioPacket;
}
