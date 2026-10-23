// WebRTC plumbing shared by every camera-preview peer (offscreen document,
// content-script overlay, and the preview page).

export const toSessionDescriptionInit = (
	description: RTCSessionDescription | null,
): RTCSessionDescriptionInit => {
	if (!description) throw new Error("Missing session description");
	return {
		type: description.type,
		sdp: description.sdp,
	};
};

const ICE_GATHERING_TIMEOUT_MS = 2000;

export const waitForIceGatheringComplete = (
	peer: RTCPeerConnection,
	timeoutMs = ICE_GATHERING_TIMEOUT_MS,
) =>
	new Promise<void>((resolve) => {
		if (peer.iceGatheringState === "complete") {
			resolve();
			return;
		}

		const finish = () => {
			globalThis.clearTimeout(timeout);
			peer.removeEventListener(
				"icegatheringstatechange",
				handleIceGatheringStateChange,
			);
			resolve();
		};

		const handleIceGatheringStateChange = () => {
			if (peer.iceGatheringState !== "complete") return;
			finish();
		};

		const timeout = globalThis.setTimeout(finish, timeoutMs);
		peer.addEventListener(
			"icegatheringstatechange",
			handleIceGatheringStateChange,
		);
	});
