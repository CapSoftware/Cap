import { SpeedController } from "@/components/tools/SpeedController";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";

const content = {
	title: "Video Speed Controller (0.25×-3×)",
	description:
		"Instantly speed up or slow down any MP4, WebM or MOV in your browser. No uploads, no quality loss.",
	featuresTitle: "Why Use Our Online Video Speed Controller?",
	featuresDescription:
		"Powered by WebCodecs + Remotion, Cap processes every frame locally for near-instant results—while keeping your files 100% private.",
	features: [
		{
			title: "WebCodecs-Level Speed",
			description:
				"Modern browser APIs crunch frames directly on your GPU/CPU, so even large clips render in seconds.",
		},
		{
			title: "100% Private",
			description:
				"Nothing ever touches a server. All encoding and decoding stays on-device.",
		},
		{
			title: "Fine-Grained Control (0.25×-3×)",
			description:
				"Dial in super-slow 0.25× for tutorials or crank up to 3× for snappy demos—audio pitch is auto-corrected.",
		},
	],
	faqs: [
		{
			question: "What video formats can I adjust?",
			answer:
				"MP4, WebM, MOV, AVI and MKV are all supported—basically anything modern browsers can decode. Chrome is recommended for best results.",
		},
		{
			question: "Is there a file-size limit?",
			answer: "Up to 500 MB for smooth in-browser performance.",
		},
		{
			question: "Will my video quality drop?",
			answer:
				"No. We preserve your original resolution and bitrate; only playback speed changes.",
		},
		{
			question: "Why is processing still slow on my laptop?",
			answer:
				"WebCodecs relies on your device's hardware. Older CPUs/GPUs or throttled mobiles will take longer.",
		},
		{
			question: "Can I use this on iOS / Android?",
			answer:
				"Yes—modern Safari, Chrome and Firefox are supported, but Chrome is recommended.",
		},
	],
	cta: {
		title: "Need heavier-duty video tools?",
		description:
			"Grab Cap — the open-source screen recorder & editor that lives on your machine.",
		buttonText: "Download Cap Free",
	},
};

export default function SpeedControllerPage() {
	return (
		<ToolsPageTemplate content={content} toolComponent={<SpeedController />} />
	);
}

export const metadata = {
	title:
		"Video Speed Controller Online – Speed Up or Slow Down Videos (0.25×-3×)",
	description:
		"Free WebCodecs-powered tool to change video speed online. Adjust playback from 0.25× to 3× without quality loss—processed locally for privacy.",
	keywords: [
		"video speed controller",
		"speed up video online",
		"slow down video online",
		"change video playback speed",
		"adjust video speed in browser",
	],
	alternates: {
		canonical: "https://cap.so/tools/video-speed-controller",
	},
};
