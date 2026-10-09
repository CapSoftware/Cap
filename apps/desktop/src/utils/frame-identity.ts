export type RenderedFrameIdentity = {
	frameNumber: number;
	targetTimeNs: bigint;
};

export function readFrameIdentity(metadata: DataView): RenderedFrameIdentity {
	return {
		frameNumber: metadata.getUint32(12, true),
		targetTimeNs: metadata.getBigUint64(16, true),
	};
}
