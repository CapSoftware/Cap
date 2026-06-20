import { registerMediabunnyServer } from "@mediabunny/server";
import * as NodeAv from "node-av";

let registered = false;
let softwareEncodersPreferred = false;

function preferSoftwareEncoders(): void {
	if (softwareEncodersPreferred) return;

	const originalFindEncoder = NodeAv.Codec.findEncoder.bind(NodeAv.Codec);
	type CodecId = Parameters<typeof NodeAv.Codec.findEncoder>[0];
	type EncoderName = Parameters<typeof NodeAv.Codec.findEncoderByName>[0];
	const softwareEncoders: Array<[CodecId, EncoderName]> = [
		[NodeAv.AV_CODEC_ID_H264, NodeAv.FF_ENCODER_LIBX264],
		[NodeAv.AV_CODEC_ID_HEVC, NodeAv.FF_ENCODER_LIBX265],
	];

	Object.defineProperty(NodeAv.Codec, "findEncoder", {
		value: (codecId: CodecId) => {
			const softwareEncoder = softwareEncoders.find(
				([candidate]) => candidate === codecId,
			)?.[1];
			if (softwareEncoder) {
				const codec = NodeAv.Codec.findEncoderByName(softwareEncoder);
				if (codec) return codec;
			}

			return originalFindEncoder(codecId);
		},
	});

	softwareEncodersPreferred = true;
}

export function registerMediaEngine(): void {
	if (registered) return;
	preferSoftwareEncoders();
	registerMediabunnyServer();
	registered = true;
}

export function getMediaEngineStatus(): {
	available: boolean;
	name: string;
	version: string;
} {
	try {
		registerMediaEngine();
		return {
			available: true,
			name: "mediabunny-server",
			version: "node-av",
		};
	} catch {
		return {
			available: false,
			name: "mediabunny-server",
			version: "unknown",
		};
	}
}
