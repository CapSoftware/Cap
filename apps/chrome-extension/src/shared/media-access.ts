type GetUserMedia = (
	constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

const isNotFound = (error: unknown) =>
	error instanceof DOMException && error.name === "NotFoundError";

// One prompt grants both devices, but Chrome rejects the pair with
// NotFoundError when either one is missing. Fall back to each device on its
// own so a machine without a camera can still grant the microphone.
export const requestCameraAndMicrophone = async (
	getUserMedia: GetUserMedia,
): Promise<MediaStream> => {
	try {
		return await getUserMedia({ video: true, audio: true });
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
	try {
		return await getUserMedia({ video: true, audio: false });
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
	return getUserMedia({ video: false, audio: true });
};
