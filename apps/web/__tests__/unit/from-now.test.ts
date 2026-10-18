import moment from "moment";
import { describe, expect, it } from "vitest";
import { fromNow } from "../../app/s/[videoId]/_components/utils/from-now";

// `fromNow` replaced the share header's `moment(date).fromNow()` so the page
// stops shipping moment; moment itself (still installed for other routes) is
// the oracle that the replacement's bucket boundaries match exactly.
describe("fromNow", () => {
	const now = new Date("2026-08-07T12:00:00.000Z");

	const offsetsSeconds = [
		0,
		1,
		44,
		45,
		89,
		90,
		91,
		60 * 44,
		60 * 45,
		60 * 89,
		60 * 90,
		60 * 91,
		3600 * 21,
		3600 * 22,
		3600 * 35,
		3600 * 36,
		3600 * 37,
		86400 * 25,
		86400 * 26,
		86400 * 44,
		86400 * 45,
		86400 * 46,
		86400 * 100,
		86400 * 319,
		86400 * 320,
		86400 * 547,
		86400 * 548,
		86400 * 549,
		86400 * 1000,
		86400 * 3650,
	];

	it("matches moment.fromNow for past dates across every bucket boundary", () => {
		for (const seconds of offsetsSeconds) {
			const date = new Date(now.getTime() - seconds * 1000);
			expect(fromNow(date, now), `offset -${seconds}s`).toBe(
				moment(date).from(moment(now)),
			);
		}
	});

	it("matches moment.fromNow for future dates", () => {
		for (const seconds of offsetsSeconds) {
			const date = new Date(now.getTime() + seconds * 1000);
			expect(fromNow(date, now), `offset +${seconds}s`).toBe(
				moment(date).from(moment(now)),
			);
		}
	});

	it("sweeps four years of offsets against moment", () => {
		for (let hours = 0; hours < 24 * 365 * 4; hours += 7) {
			const date = new Date(now.getTime() - hours * 3600 * 1000);
			expect(fromNow(date, now), `offset -${hours}h`).toBe(
				moment(date).from(moment(now)),
			);
		}
	});
});
