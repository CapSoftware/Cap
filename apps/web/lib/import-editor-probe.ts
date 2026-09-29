import {
	type ImportEditorSource,
	type ImportMediaFacts,
	importEditorSourcePlan,
	isobmffLayout,
} from "./import-editor-source";

const PACKET_STATS_TARGET = 240;

/**
 * How an imported file can open in the editor before processing, or null
 * when it has to wait for it. Never throws: a file this can't read just waits.
 */
export async function probeImportEditorSource(
	file: Blob,
): Promise<ImportEditorSource | null> {
	try {
		const { ALL_FORMATS, BlobSource, Input, MP4, QTFF } = await import(
			"mediabunny"
		);
		const input = new Input({
			formats: ALL_FORMATS,
			source: new BlobSource(file),
		});
		try {
			const format = await input.getFormat();
			const container =
				format === MP4 ? "mp4" : format === QTFF ? "quicktime" : "other";
			if (container === "other") return null;
			const layout = await isobmffLayout(
				async (start, end) =>
					new Uint8Array(await file.slice(start, end).arrayBuffer()),
				file.size,
			);
			if (layout !== "faststart") return null;
			const [videoTracks, audioTracks, duration] = await Promise.all([
				input.getVideoTracks(),
				input.getAudioTracks(),
				input.computeDuration(),
			]);
			const facts: ImportMediaFacts = {
				container,
				layout,
				duration,
				videoTracks: await Promise.all(
					videoTracks.map(async (track) => {
						const [
							codecString,
							width,
							height,
							rotation,
							aspect,
							firstTimestamp,
							stats,
							decodable,
						] = await Promise.all([
							track.getCodecParameterString(),
							track.getCodedWidth(),
							track.getCodedHeight(),
							track.getRotation(),
							track.getPixelAspectRatio(),
							track.getFirstTimestamp(),
							track.computePacketStats(PACKET_STATS_TARGET),
							track.canDecode(),
						]);
						return {
							codec: track.codec,
							codecString,
							width,
							height,
							rotation,
							squarePixels: aspect.num === aspect.den,
							firstTimestamp,
							packetRate: stats.averagePacketRate,
							decodable,
						};
					}),
				),
				audioTracks: await Promise.all(
					audioTracks.map(async (track) => ({
						codec: track.codec,
						firstTimestamp: await track.getFirstTimestamp(),
						decodable: await track.canDecode(),
					})),
				),
			};
			return importEditorSourcePlan(facts);
		} finally {
			input.dispose();
		}
	} catch (error) {
		console.warn("Import will open after processing", error);
		return null;
	}
}
