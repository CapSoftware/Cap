import { expect, test } from "vitest";
import { reportUnlessClosed } from "./browser-audio-playback";

function pendingResume() {
	let reject: (cause: unknown) => void = () => undefined;
	const promise = new Promise<void>((_, rejectPromise) => {
		reject = rejectPromise;
	});
	return { promise, reject };
}

test("a resume that fails after the playback closed its context is not a playback error", async () => {
	const resume = pendingResume();
	let open = true;
	const errors: Error[] = [];
	const settled = reportUnlessClosed(
		resume.promise,
		() => open,
		(error) => errors.push(error),
	);
	open = false;
	resume.reject(new DOMException("AudioContext closed", "InvalidStateError"));
	await settled;
	expect(errors).toEqual([]);
});

test("a resume that fails while the context is open is reported", async () => {
	const resume = pendingResume();
	const errors: Error[] = [];
	const settled = reportUnlessClosed(
		resume.promise,
		() => true,
		(error) => errors.push(error),
	);
	resume.reject("device lost");
	await settled;
	expect(errors.map((error) => error.message)).toEqual(["device lost"]);
});
