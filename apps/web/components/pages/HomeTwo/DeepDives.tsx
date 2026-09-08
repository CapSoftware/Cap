"use client";

import {
	BookOpen,
	Captions,
	Copy,
	EyeOff,
	FileText,
	Globe,
	Layers,
	LayoutGrid,
	Link2,
	Maximize2,
	MousePointerClick,
	MoveUpRight,
	Palette,
	Square,
	Type,
	Upload,
} from "lucide-react";
import { DeepDive, type DiveConfig } from "./DeepDive";
import { StudioFeatures } from "./studio/StudioFeatures";

const INSTANT: DiveConfig = {
	mode: "instant",
	eyebrow: "Instant Mode",
	heading: "Share your screen or webcam instantly",
	intro:
		"Hit record, stop, and share. Your video is live with a title, summary, chapters, and transcript, all written for you.",
	href: "/features",
	items: [
		{
			title: "Uploads while you record",
			body: "Instant Mode streams to the cloud as you go, so the video is ready the moment you press stop.",
		},
		{
			title: "The link is on your clipboard",
			body: "Press stop and it is already copied, ready to paste into Slack, a ticket, or an email.",
		},
		{
			title: "Share publicly or privately",
			body: "Password protect the sensitive ones, keep a link to your team, or leave it public. You decide who can watch.",
		},
	],
	chips: [
		{
			title: "Instant links",
			description: "Shareable URL, immediately",
			Icon: Link2,
		},
		{
			title: "Background upload",
			description: "Uploads while you record",
			Icon: Upload,
		},
		{
			title: "Auto transcription",
			description: "Captions on every recording",
			Icon: Captions,
		},
		{
			title: "AI summaries",
			description: "Titles and descriptions",
			Icon: FileText,
		},
		{
			title: "Smart chapters",
			description: "Auto segmented timeline",
			Icon: BookOpen,
		},
		{
			title: "Browser viewing",
			description: "No downloads required",
			Icon: Globe,
		},
	],
};

const STUDIO: DiveConfig = {
	mode: "studio",
	eyebrow: "Studio Mode",
	heading: "Record in full quality, edit before you share",
	intro:
		"Studio records at the highest quality straight to your device, with no compression and no upload. Then blur what is private, switch scenes between screen and camera, add text and captions, and set the look before anyone sees it.",
	href: "/features",
	flip: true,
	items: [
		{
			title: "Records locally in full quality",
			body: "4K at 60fps straight to your device, with no compression and no upload. Screen, camera, and mic each stay on their own track.",
		},
		{
			title: "An editor built in",
			body: "Custom backgrounds, adjustable padding, rounded corners, shadows and borders, all set before anyone sees it.",
		},
		{
			title: "Automatic zoom and cursor effects",
			body: "Cap smooths the cursor, adds click effects and natural motion blur, and zooms in where the action is.",
		},
	],
	chips: [
		{
			title: "Custom backgrounds",
			description: "Gradients, wallpapers, colours",
			Icon: Palette,
		},
		{
			title: "Adjustable padding",
			description: "Scale from 0% to 40%",
			Icon: Maximize2,
		},
		{
			title: "Blur sensitive areas",
			description: "Mask, pixelate, or highlight",
			Icon: EyeOff,
		},
		{
			title: "Scenes and split screen",
			description: "Camera only, split, or floating",
			Icon: LayoutGrid,
		},
		{
			title: "Text and captions",
			description: "Animated titles, local captions",
			Icon: Type,
		},
		{
			title: "Cursor effects",
			description: "Sizing, smoothing, click effects",
			Icon: MousePointerClick,
		},
	],
};

const SCREENSHOT: DiveConfig = {
	mode: "screenshot",
	eyebrow: "Screenshot Mode",
	heading: "Capture, beautify, share",
	intro:
		"One hotkey grabs the window, and the same editing tools that polish your videos turn the still into something worth pasting.",
	href: "/features",
	items: [
		{
			title: "Capture and beautify in one hotkey",
			body: "Grab any window or area and Cap drops it on a background with padding, rounded corners, and a shadow.",
		},
		{
			title: "Annotate, then copy",
			body: "Point out the bug or the button you mean, then send the result straight to your clipboard or save it as a file.",
		},
	],
	chips: [
		{
			title: "Beautiful backgrounds",
			description: "Gradients, wallpapers, solid colours",
			Icon: Palette,
		},
		{
			title: "Adjustable padding",
			description: "Clean spacing around the capture",
			Icon: Maximize2,
		},
		{
			title: "Rounded corners",
			description: "Squircle or rounded styles",
			Icon: Square,
		},
		{
			title: "Shadow and borders",
			description: "Depth without the fuss",
			Icon: Layers,
		},
		{
			title: "Annotation tools",
			description: "Arrows, shapes, text, masks",
			Icon: MoveUpRight,
		},
		{
			title: "Instant copy and save",
			description: "One click to clipboard or file",
			Icon: Copy,
		},
	],
};

const UNDERSTAND: DiveConfig = {
	mode: "share",
	eyebrow: "Cap AI · On every recording",
	heading: "Every recording, understood",
	intro:
		"Titles, summaries, chapters, and a searchable transcript arrive with the recording, so the work after the recording is already done.",
	href: "/features",
	flip: true,
	items: [
		{
			title: "Auto transcription",
			body: "Every word transcribed and timestamped, so viewers can search the recording instead of scrubbing it.",
		},
		{
			title: "Titles, summaries, and chapters",
			body: "Written the moment you finish recording, with clickable chapters viewers can skim.",
		},
		{
			title: "Comments and reactions",
			body: "Feedback lands at the exact timestamp it is about, so the conversation stays with the recording.",
		},
	],
};

export const DeepDives = () => (
	<>
		<DeepDive config={INSTANT} />
		<DeepDive config={STUDIO} />
		<StudioFeatures />
		<DeepDive config={SCREENSHOT} />
		<DeepDive config={UNDERSTAND} />
	</>
);
