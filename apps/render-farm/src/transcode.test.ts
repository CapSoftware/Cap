import { describe, expect, test } from "bun:test";
import { encodedSeconds, transcodeArgs } from "./transcode";

describe("transcodeArgs", () => {
	test("NVENC keeps frames on the GPU and forces one-second IDR frames", () => {
		const args = transcodeArgs("https://in", "/tmp/out.mp4", 1, "h264_nvenc");
		expect(
			args.slice(args.indexOf("-hwaccel"), args.indexOf("-hwaccel") + 2),
		).toEqual(["-hwaccel", "cuda"]);
		expect(args).toContain("expr:gte(t,n_forced*1)");
		expect(
			args.slice(args.indexOf("-forced-idr"), args.indexOf("-forced-idr") + 2),
		).toEqual(["-forced-idr", "1"]);
		expect(args.slice(args.indexOf("-bf"), args.indexOf("-bf") + 2)).toEqual([
			"-bf",
			"0",
		]);
		expect(
			args.slice(args.indexOf("-fps_mode"), args.indexOf("-fps_mode") + 2),
		).toEqual(["-fps_mode", "passthrough"]);
		expect(args.at(-1)).toBe("/tmp/out.mp4");
		expect(args.slice(-3, -1)).toEqual(["-movflags", "+faststart"]);
	});

	test("a CPU encoder drops the GPU options", () => {
		const args = transcodeArgs("https://in", "/tmp/out.mp4", 2, "libx264");
		expect(args).not.toContain("-hwaccel");
		expect(args).not.toContain("-forced-idr");
		expect(args).toContain("expr:gte(t,n_forced*2)");
	});
});

describe("encodedSeconds", () => {
	test("reads ffmpeg progress output times", () => {
		expect(encodedSeconds("out_time_us=2500000")).toBe(2.5);
		expect(encodedSeconds("out_time_ms=1000000")).toBe(1);
		expect(encodedSeconds("frame=12")).toBeNull();
		expect(encodedSeconds("out_time=00:00:01.000000")).toBeNull();
	});
});
