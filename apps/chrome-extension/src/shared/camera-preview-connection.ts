import { sendServiceWorkerMessage } from "./runtime";
import type { WebcamSettings } from "./types";
import {
	toSessionDescriptionInit,
	waitForIceGatheringComplete,
} from "./webrtc";

type RemoteStreamOutcome = { stream: MediaStream } | { error: Error };

export const connectCameraPreview = async (
	settings: WebcamSettings,
	sessionId: string,
) => {
	const peer = new RTCPeerConnection();
	const received: { stream: MediaStream | null } = { stream: null };
	let cancelWait = () => {};
	const remoteStreamPromise = new Promise<RemoteStreamOutcome>((resolve) => {
		let settled = false;
		const finish = (outcome: RemoteStreamOutcome) => {
			if (settled) return;
			settled = true;
			globalThis.clearTimeout(timeout);
			peer.removeEventListener("track", handleTrack);
			peer.removeEventListener("connectionstatechange", handleStateChange);
			resolve(outcome);
		};
		const handleTrack = (event: RTCTrackEvent) => {
			received.stream = event.streams[0] ?? new MediaStream([event.track]);
			finish({ stream: received.stream });
		};
		const handleStateChange = () => {
			if (
				peer.connectionState === "failed" ||
				peer.connectionState === "closed"
			) {
				finish({ error: new Error("Camera preview connection failed.") });
			}
		};
		const timeout = globalThis.setTimeout(() => {
			finish({ error: new Error("Camera preview timed out.") });
		}, 10_000);
		cancelWait = () =>
			finish({ error: new Error("Camera preview cancelled.") });
		peer.addEventListener("track", handleTrack);
		peer.addEventListener("connectionstatechange", handleStateChange);
	});

	try {
		peer.addTransceiver("video", { direction: "recvonly" });
		await peer.setLocalDescription(await peer.createOffer());
		await waitForIceGatheringComplete(peer);
		const response = await sendServiceWorkerMessage({
			target: "service-worker",
			type: "connect-camera-preview",
			sessionId,
			settings,
			offer: toSessionDescriptionInit(peer.localDescription),
		});
		if (!response.ok) throw new Error(response.error);
		if (!response.answer) {
			throw new Error("Camera preview did not return an answer.");
		}
		await peer.setRemoteDescription(response.answer);
		const outcome = await remoteStreamPromise;
		if ("error" in outcome) throw outcome.error;
		return { peer, stream: outcome.stream };
	} catch (error) {
		peer.close();
		if (received.stream) {
			for (const track of received.stream.getTracks()) {
				track.stop();
			}
		}
		throw error;
	} finally {
		cancelWait();
	}
};
