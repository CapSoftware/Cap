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

export const waitForIceGatheringComplete = (peer: RTCPeerConnection) =>
	new Promise<void>((resolve) => {
		if (peer.iceGatheringState === "complete") {
			resolve();
			return;
		}

		const handleIceGatheringStateChange = () => {
			if (peer.iceGatheringState !== "complete") return;
			peer.removeEventListener(
				"icegatheringstatechange",
				handleIceGatheringStateChange,
			);
			resolve();
		};

		peer.addEventListener(
			"icegatheringstatechange",
			handleIceGatheringStateChange,
		);
	});
