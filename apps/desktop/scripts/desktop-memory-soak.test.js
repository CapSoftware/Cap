import { describe, expect, it } from "vitest";
import {
	buildSample,
	classifyProcess,
	DEFAULTS,
	evaluateCycles,
	parsePsOutput,
	pickSettledSample,
} from "./desktop-memory-soak-lib.js";

describe("desktop-memory-soak", () => {
	it("classifies Cap and media processes", () => {
		expect(classifyProcess(DEFAULTS.appCommandPrefix)).toMatchObject({
			group: "cap",
			kind: "cap-main",
		});
		expect(
			classifyProcess(
				`${DEFAULTS.appCommandPrefix} --crash-reporter-server=/tmp/socket`,
			),
		).toMatchObject({
			group: "cap",
			kind: "cap-crash",
		});
		expect(
			classifyProcess(
				"/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
			),
		).toMatchObject({
			group: "cap",
			kind: "webkit-webcontent",
		});
		expect(classifyProcess("/usr/sbin/coreaudiod")).toMatchObject({
			group: "media",
			kind: "coreaudiod",
		});
		expect(
			classifyProcess(
				"/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon",
			),
		).toMatchObject({
			group: "system",
			kind: "window-server",
		});
	});

	it("parses ps output and totals tracked processes", () => {
		const processes = parsePsOutput(`
1000 1200000 435000000 00:16:39 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon
2004 400000 441000000 00:02:00 ${DEFAULTS.appCommandPrefix}
2005 25000 435000000 00:02:00 ${DEFAULTS.appCommandPrefix} --crash-reporter-server=/tmp/socket
2008 90000 440000000 00:02:00 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU
2075 300000 507000000 00:01:55 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
431 50000 435000000 00:16:39 /usr/sbin/coreaudiod
532 20000 435000000 00:16:39 /usr/libexec/cameracaptured
`);

		const sample = buildSample(processes, new Map(), DEFAULTS);

		expect(sample.capTotalKb).toBe(815000);
		expect(sample.mediaTotalKb).toBe(70000);
		expect(sample.windowServerTotalKb).toBe(1200000);
		expect(sample.grandTotalKb).toBe(2085000);
		expect(sample.newPids).toEqual([431, 532, 1000, 2004, 2005, 2008, 2075]);
	});

	it("picks the lowest sample from the trailing settle window", () => {
		const settled = pickSettledSample(
			[
				{ grandTotalKb: 1200 },
				{ grandTotalKb: 1000 },
				{ grandTotalKb: 900 },
				{ grandTotalKb: 950 },
			],
			3,
		);

		expect(settled.grandTotalKb).toBe(900);
	});

	it("flags cycle ratchet and total growth failures", () => {
		const failures = evaluateCycles(1000, [1200, 1400, 2200], {
			...DEFAULTS,
			maxCycleRatchetMb: 0.1,
			maxTotalGrowthMb: 0.5,
		});

		expect(failures).toEqual([
			{ cycle: 1, type: "cycle-ratchet", valueKb: 200 },
			{ cycle: 2, type: "cycle-ratchet", valueKb: 200 },
			{ cycle: 3, type: "cycle-ratchet", valueKb: 800 },
			{ cycle: 3, type: "total-growth", valueKb: 1200 },
		]);
	});
});
