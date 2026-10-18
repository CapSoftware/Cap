import { describe, expect, it, vi } from "vitest";
import { captureDisplayStream } from "./display-capture";

const stream = {} as MediaStream;

describe("captureDisplayStream", () => {
	it("falls back when advanced options are rejected before a picker can open", async () => {
		const request = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("Unsupported display option"))
			.mockResolvedValueOnce(stream);

		await expect(
			captureDisplayStream("fullscreen", true, request),
		).resolves.toBe(stream);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[1]?.[0]).toMatchObject({
			audio: true,
		});
		expect(request.mock.calls[1]?.[0]).not.toHaveProperty(
			"monitorTypeSurfaces",
		);
	});

	it("falls back to video only when audio is rejected before a picker can open", async () => {
		const request = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("Unsupported display option"))
			.mockRejectedValueOnce(
				new DOMException("Audio unsupported", "NotSupportedError"),
			)
			.mockResolvedValueOnce(stream);

		await expect(captureDisplayStream("window", true, request)).resolves.toBe(
			stream,
		);
		expect(request).toHaveBeenCalledTimes(3);
		expect(request.mock.calls[2]?.[0]).toMatchObject({ audio: false });
	});

	it("does not reopen the picker after an asynchronous capture failure", async () => {
		const request = vi.fn(
			() =>
				new Promise<MediaStream>((_resolve, reject) => {
					globalThis.setTimeout(
						() =>
							reject(new DOMException("Capture failed", "NotSupportedError")),
						0,
					);
				}),
		);

		await expect(
			captureDisplayStream("fullscreen", true, request),
		).rejects.toThrow("Capture failed");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry a dismissed picker", async () => {
		const request = vi
			.fn()
			.mockRejectedValue(
				new DOMException("Permission denied", "NotAllowedError"),
			);

		await expect(
			captureDisplayStream("fullscreen", false, request),
		).rejects.toThrow("Permission denied");
		expect(request).toHaveBeenCalledTimes(1);
	});
});
