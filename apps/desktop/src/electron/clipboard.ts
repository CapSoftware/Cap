import { native } from "./bridge";
export const readText = () => native<string>("clipboard.readText");
export const writeText = (text: string) =>
	native<void>("clipboard.writeText", { text });
export const readImage = () =>
	Promise.reject(new Error("readImage is not implemented"));
export const writeImage = (_image: unknown) =>
	Promise.reject(new Error("writeImage is not implemented"));
export const clear = () => writeText("");
