"use client";

import { useMemo } from "react";

export type RendererMode = "canvas" | "legacy";

const STORAGE_KEY = "cap-editor-renderer-mode";

function getRendererModeFromUrl(): RendererMode | null {
	if (typeof window === "undefined") return null;
	const params = new URLSearchParams(window.location.search);
	const value = params.get("renderer");
	if (value === "legacy" || value === "canvas") return value;
	return null;
}

function getRendererModeFromStorage(): RendererMode | null {
	if (typeof window === "undefined") return null;
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		if (value === "legacy" || value === "canvas") return value;
	} catch {
		return null;
	}
	return null;
}

function persistRendererMode(mode: RendererMode): void {
	if (typeof window === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, mode);
	} catch {}
}

export function useRendererMode(): RendererMode {
	return useMemo(() => {
		const fromUrl = getRendererModeFromUrl();
		if (fromUrl) {
			persistRendererMode(fromUrl);
			return fromUrl;
		}

		const fromStorage = getRendererModeFromStorage();
		if (fromStorage) return fromStorage;

		return "canvas";
	}, []);
}
