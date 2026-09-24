import type { OsType, Platform } from "@tauri-apps/plugin-os";

function browserOs(): OsType {
	const agent = navigator.userAgent;
	if (/Windows/i.test(agent)) return "windows";
	if (/Android/i.test(agent)) return "android";
	if (/iPhone|iPad|iPod/i.test(agent)) return "ios";
	if (/Macintosh|Mac OS X/i.test(agent)) return "macos";
	return "linux";
}

export function type(): OsType {
	return browserOs();
}

export function platform(): Platform {
	return browserOs();
}

export function arch() {
	const os = browserOs();
	if (os === "macos" || os === "ios" || os === "android") return "aarch64";
	return "x86_64";
}

export function family() {
	return browserOs() === "windows" ? "windows" : "unix";
}

export function eol() {
	return browserOs() === "windows" ? "\r\n" : "\n";
}

export function exeExtension() {
	return browserOs() === "windows" ? "exe" : "";
}

export function version() {
	return "0";
}

export async function locale() {
	return navigator.language || null;
}

export async function hostname() {
	return location.hostname;
}
