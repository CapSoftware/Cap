import { readFile } from "node:fs/promises";
import path from "node:path";

export type OgFont = {
	name: string;
	data: ArrayBuffer;
	weight: 400 | 500 | 700;
	style: "normal";
};

let fontsPromise: Promise<OgFont[]> | null = null;

const loadFont = async (
	file: string,
	weight: OgFont["weight"],
): Promise<OgFont> => {
	const data = await readFile(
		path.join(process.cwd(), "lib", "og", "fonts", file),
	);
	return {
		name: "Neue Montreal",
		data: data.buffer.slice(
			data.byteOffset,
			data.byteOffset + data.byteLength,
		) as ArrayBuffer,
		weight,
		style: "normal",
	};
};

export const loadOgFonts = () => {
	fontsPromise ??= Promise.all([
		loadFont("NeueMontreal-Regular.ttf", 400),
		loadFont("NeueMontreal-Medium.ttf", 500),
		loadFont("NeueMontreal-Bold.ttf", 700),
	]).catch((error) => {
		fontsPromise = null;
		throw error;
	});
	return fontsPromise;
};
