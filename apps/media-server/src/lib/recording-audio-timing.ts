import { createHash } from "node:crypto";
import { EncodedPacketSink, FilePathSource, Input, MP4 } from "mediabunny";
import { RecordingTimingError } from "./recording-timing";

async function inspectAudioTail(path: string, countPackets = false) {
	const source = new FilePathSource(path).ref();
	const input = new Input({ formats: [MP4], source });
	let formatReady = false;
	try {
		await input.getFormat();
		formatReady = true;
		const tracks = await input.getAudioTracks();
		if (tracks.length !== 1)
			throw new Error("Recording audio tracks are ambiguous");
		const sink = new EncodedPacketSink(tracks[0]);
		const packet = await sink.getPacket(Number.POSITIVE_INFINITY, {
			skipLiveWait: true,
		});
		if (
			!packet ||
			(await sink.getNextPacket(packet, {
				metadataOnly: true,
				skipLiveWait: true,
			}))
		)
			throw new Error("Recording audio tail is ambiguous");
		const scale = await tracks[0].getTimeResolution();
		const scaled = packet.duration * scale;
		const ticks = Math.round(scaled);
		const tolerance = Math.max(
			0.0000001,
			Math.abs(scaled) * Number.EPSILON * 4,
		);
		if (
			!Number.isSafeInteger(scale) ||
			scale <= 0 ||
			!Number.isSafeInteger(ticks) ||
			ticks <= 0 ||
			tolerance >= 0.25 ||
			Math.abs(scaled - ticks) > tolerance ||
			!Number.isSafeInteger(packet.sequenceNumber) ||
			packet.sequenceNumber < 0
		)
			throw new Error("Recording audio duration is not exact");
		let packetCount: number | undefined;
		if (countPackets) {
			packetCount = 0;
			for await (const _packet of sink.packets(undefined, undefined, {
				metadataOnly: true,
				skipLiveWait: true,
			})) {
				packetCount++;
			}
		}
		if (
			packetCount !== undefined &&
			(!Number.isSafeInteger(packetCount) || packetCount <= 0)
		)
			throw new Error("Recording audio packet count is invalid");
		return {
			packetCount,
			durationTicks: ticks,
			timeScale: scale,
			size: packet.byteLength,
			hash: `SHA256:${createHash("sha256").update(packet.data).digest("hex")}`,
		};
	} catch (error) {
		const retryable =
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			typeof error.code === "string";
		const failure = new RecordingTimingError(
			retryable
				? "Recording audio timing inspection was interrupted"
				: "Recording audio timing is invalid",
			retryable,
		);
		failure.cause = error;
		throw failure;
	} finally {
		// Mediabunny 1.45 disposal leaks rejections after failed format detection and can strand pending reads.
		if (formatReady) input.dispose();
		else source.free();
	}
}

if (import.meta.main) {
	try {
		const path = process.argv[2];
		if (!path) throw new Error("Missing audio timing path");
		console.log(
			JSON.stringify(await inspectAudioTail(path, process.argv[3] === "count")),
		);
	} catch (error) {
		console.log(
			JSON.stringify({
				error:
					error instanceof RecordingTimingError && !error.retryable
						? "invalid"
						: "unavailable",
			}),
		);
		process.exitCode = 1;
	}
}
