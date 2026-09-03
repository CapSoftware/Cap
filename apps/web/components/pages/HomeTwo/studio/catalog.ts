"use client";

import dynamic from "next/dynamic";
import type { StudioCard } from "./shared";

export const CARDS_A: StudioCard[] = [
	{
		key: "mask",
		title: "Blur what is private",
		body: "Drop a mask over a password, an email, or a face and choose blur or pixelate. Or flip it to a highlight that dims everything else.",
		span: 2,
		Visual: dynamic(() =>
			import("./cardsA").then((module) => module.BlurVisual),
		),
	},
	{
		key: "scenes",
		title: "Scenes for screen and camera",
		body: "Switch any stretch of the timeline to camera only, hide camera, split screen, or floating cards, each with its own transition.",
		span: 2,
		Visual: dynamic(() =>
			import("./cardsA").then((module) => module.ScenesVisual),
		),
	},
	{
		key: "text",
		title: "Text that animates",
		body: "Titles, lower thirds, big stats, and typewriter callouts as stackable tracks, with fade, slide, pop, or typewriter in and out.",
		Visual: dynamic(() =>
			import("./cardsA").then((module) => module.TextVisual),
		),
	},
	{
		key: "zoom",
		title: "Automatic zoom",
		body: "Generate zooms from your recorded clicks, or draw your own from 1x to 4.5x with a fixed focal point.",
		Visual: dynamic(() =>
			import("./cardsA").then((module) => module.ZoomVisual),
		),
	},
	{
		key: "captions",
		title: "Captions, generated locally",
		body: "Transcribe on your machine in 19 languages, fix the words, style them, and burn them in with the active word highlighted.",
		Visual: dynamic(() =>
			import("./cardsA").then((module) => module.CaptionsVisual),
		),
	},
];

export const CARDS_B: StudioCard[] = [
	{
		key: "three-d",
		title: "3D camera moves",
		body: "Tilt the frame into perspective and glide, sweep, or pull back across it with focus blur.",
		Visual: dynamic(() =>
			import("./cardsB").then((module) => module.ThreeDVisual),
		),
	},
	{
		key: "canvas",
		title: "Any canvas, one recording",
		body: "Wallpapers, gradients, or your own image, then padding, corners, shadows, and a macOS, Windows, browser, or MacBook frame.",
		Visual: dynamic(() =>
			import("./cardsB").then((module) => module.CanvasVisual),
		),
	},
	{
		key: "grades",
		title: "Color grades",
		body: "Cinematic, Noir, Vintage, Frost, Golden, Midnight, Vivid, or Dreamy, then dial exposure, contrast, and vignette.",
		Visual: dynamic(() =>
			import("./cardsB").then((module) => module.GradesVisual),
		),
	},
	{
		key: "clips",
		title: "Clips, speed, and music",
		body: "Trim, split, reorder, speed up to 8x, crossfade between clips, and lay a track from the built in library underneath.",
		Visual: dynamic(() =>
			import("./cardsB").then((module) => module.ClipsVisual),
		),
	},
];
