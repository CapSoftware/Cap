import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	check,
	readNames,
	usages,
	withoutTestCode,
} from "./check-components.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const names = readNames(
	await readFile(path.join(here, "ffmpeg-7.1-names.txt"), "utf8"),
);

test("shipped code only uses FFmpeg components that are built", async () => {
	assert.deepEqual(await check(), []);
});

test("finds encoders, muxers and filter graph filters", () => {
	const found = usages(
		`
		fn encode() {
			let codec = ffmpeg::encoder::find_by_name("libx265");
			let mjpeg = ffmpeg::encoder::find(ffmpeg::codec::Id::MJPEG);
			let names = ["h264_nvenc", "av1_qsv"];
			let output = format::output_as(&path, "matroska");
		}
		fn graph() {
			let graph = filter::Graph::new();
			graph.add(&filter::find("abuffer").unwrap(), "in", "time_base=1/48000");
			graph.output("in", 0)?.input("out", 0)?.parse(&format!("highpass=f=80,volume={gain}dB"))?;
		}
		`,
		names,
	);
	assert.deepEqual([...found.encoders].sort(), [
		"av1_qsv",
		"h264_nvenc",
		"libx265",
		"mjpeg",
	]);
	assert.deepEqual([...found.muxers], ["matroska"]);
	assert.deepEqual([...found.filters].sort(), [
		"abuffer",
		"highpass",
		"volume",
	]);
});

test("ignores test code", () => {
	const source = `
		fn shipped() { encoder::find_by_name("libx264"); }
		#[cfg(test)]
		mod tests {
			fn helper() { let s = "{"; format::output_as(&path, "nut"); encoder::find(Id::MPEG4); }
		}
		#[cfg(test)]
		use something::else;
		fn also_shipped() { format::output_as(&path, "mp4"); }
	`;
	assert.ok(!withoutTestCode(source).includes("nut"));
	const found = usages(source, names);
	assert.deepEqual([...found.encoders], ["libx264"]);
	assert.deepEqual([...found.muxers], ["mp4"]);
});
