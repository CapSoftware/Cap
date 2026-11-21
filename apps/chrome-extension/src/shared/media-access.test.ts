import { describe, expect, it, vi } from "vitest";
import { requestCameraAndMicrophone } from "./media-access";

const notFound = () =>
	new DOMException("Requested device not found", "NotFoundError");

const fakeStream = (constraints: MediaStreamConstraints) =>
	({ constraints }) as unknown as MediaStream;

const devicesPresent = (camera: boolean, microphone: boolean) =>
	vi.fn(async (constraints: MediaStreamConstraints) => {
		if (constraints.video && !camera) throw notFound();
		if (constraints.audio && !microphone) throw notFound();
		return fakeStream(constraints);
	});

describe("requestCameraAndMicrophone", () => {
	it("asks for both devices in one prompt when both exist", async () => {
		const getUserMedia = devicesPresent(true, true);
		await requestCameraAndMicrophone(getUserMedia);
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: true });
	});

	it("falls back to the camera alone when no microphone exists", async () => {
		const getUserMedia = devicesPresent(true, false);
		const stream = await requestCameraAndMicrophone(getUserMedia);
		expect(stream).toEqual(fakeStream({ video: true, audio: false }));
	});

	it("falls back to the microphone alone when no camera exists", async () => {
		const getUserMedia = devicesPresent(false, true);
		const stream = await requestCameraAndMicrophone(getUserMedia);
		expect(stream).toEqual(fakeStream({ video: false, audio: true }));
	});

	it("reports NotFoundError when neither device exists", async () => {
		await expect(
			requestCameraAndMicrophone(devicesPresent(false, false)),
		).rejects.toMatchObject({ name: "NotFoundError" });
	});

	it("does not retry when the user denies the prompt", async () => {
		const getUserMedia = vi.fn(async () => {
			throw new DOMException("Permission denied", "NotAllowedError");
		});
		await expect(
			requestCameraAndMicrophone(getUserMedia),
		).rejects.toMatchObject({ name: "NotAllowedError" });
		expect(getUserMedia).toHaveBeenCalledTimes(1);
	});
});
