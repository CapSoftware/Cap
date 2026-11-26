import { Clapperboard, Zap } from "lucide-react";
import { PRICING } from "@/data/pricing";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const openSourceScreenRecorderContent: SeoPageContent = {
	title: "Open Source Screen Recorder — Free, Private, and Community-Built",
	description:
		"Cap is an open-source screen recorder for Mac and Windows. Audit the code, self-host your recordings, and stay in full control of your data.",

	featuresTitle: "Why Choose an Open Source Screen Recorder",
	featuresDescription:
		"Open source means full transparency, real privacy, and the freedom to use Cap exactly how you want — without compromise",

	features: [
		{
			title: "Fully Open Source on GitHub",
			description:
				"Cap's source is publicly available on GitHub. Most code is licensed under AGPLv3, with specified Rust crate families under MIT. Inspect every line of code, understand exactly what happens to your recordings, and contribute features or fixes back to the community.",
		},
		{
			title: "Self-Host Your Recordings",
			description:
				"Connect Cap to any S3-compatible storage — AWS S3, Cloudflare R2, Backblaze, or your own MinIO instance. Your recordings never touch Cap's servers unless you want them to. True data ownership.",
		},
		{
			title: "No Vendor Lock-In",
			description:
				"Cap is open source. Fork it, modify it, or self-host the entire platform.",
		},
		{
			title: "Community-Driven Development",
			description:
				"Cap is built in the open with contributions from developers around the world. Features are shaped by real user needs, not quarterly revenue targets. File an issue, submit a PR, or join the discussion on GitHub.",
		},
		{
			title: "Privacy-First Architecture",
			description:
				"Because Cap is open source, privacy isn't a marketing claim — it's verifiable. Review the data handling code yourself, run the app locally, and configure storage to keep recordings entirely within your infrastructure.",
		},
		{
			title: "4K Recording at 60fps",
			description:
				"Open source doesn't mean underpowered. Cap captures your screen at up to 4K resolution and 60 frames per second with system audio and webcam overlay. Professional-grade output at zero cost.",
		},
		{
			title: "Instant Shareable Links",
			description:
				"Stop recording and Cap generates a shareable link immediately. No manual uploading, no processing queue. Paste the link in Slack, email, or any tool and viewers get instant access.",
		},
		{
			title: "AI Captions Without Compromise",
			description:
				"Automatically generate accurate captions from your screen recordings. The AI pipeline is part of the open-source codebase — you can see exactly how transcription works and run it on your own infrastructure.",
		},
	],

	recordingModes: {
		title: "Two Open Source Recording Modes",
		description:
			"Cap gives you two distinct modes so you can choose the right workflow for every recording",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode",
				description:
					"Record and share instantly with a link ready the moment you stop. Perfect for bug reports, async updates, and quick team communication. Free plan includes recordings up to 5 minutes with built-in thread commenting.",
			},
			{
				icon: (
					<Clapperboard
						fill="var(--blue-9)"
						className="mb-4 size-8"
						strokeWidth={1.5}
					/>
				),
				title: "Studio Mode",
				description:
					"Completely free for personal use with no time limits. Records at full quality up to 4K with separate screen and webcam tracks. Ideal for tutorials, product demos, and training content — no subscription required.",
			},
		],
	},

	useCasesTitle: "Who Uses Cap as Their Open Source Screen Recorder",
	useCasesDescription:
		"From privacy-conscious developers to enterprises with compliance requirements — Cap fits every team that values transparency",

	useCases: [
		{
			title: "Privacy-Conscious Developers",
			description:
				"Developers who want to verify what software does with their data choose Cap because the code is public. Self-host recordings on your own S3 bucket for complete data sovereignty with zero third-party access.",
		},
		{
			title: "Open Source Projects and Communities",
			description:
				"Open source teams use Cap to record demos, walkthroughs, and contributor onboarding videos. The shared ethos of transparency and community ownership makes Cap a natural fit for open source workflows.",
		},
		{
			title: "Enterprise Compliance Teams",
			description:
				"Organizations with strict data residency or compliance requirements deploy Cap with self-hosted storage. Keep every recording within your own infrastructure and satisfy GDPR, HIPAA, or internal security policies.",
		},
		{
			title: "Remote Development Teams",
			description:
				"Engineering teams use Cap to record bug reports, code reviews, and architecture walkthroughs. Instant shareable links drop into GitHub issues, Jira tickets, and Slack without any file transfer overhead.",
		},
		{
			title: "Educational Institutions",
			description:
				"Schools and universities choose Cap because open-source software is auditable, trustworthy, and free from unexpected pricing changes. <a href='/solutions/online-classroom-tools'>Learn how Cap supports online teaching</a>.",
		},
		{
			title: "Startups and Indie Developers",
			description:
				"Small teams get enterprise-quality async video without SaaS pricing. Cap's free Studio Mode and open-source codebase mean you can grow without worrying about per-seat costs or licensing terms.",
		},
	],

	faqsTitle: "Frequently Asked Questions About Open Source Screen Recording",
	faqs: [
		{
			question: "Is Cap really open source?",
			answer:
				"Yes. Cap is open source, with most code under AGPLv3 and specified Rust crates under MIT. The complete codebase — desktop app, web app, Rust media processing pipeline, and all backend services — is publicly available on GitHub. You can inspect every line, fork the project, and contribute back to the community.",
		},
		{
			question: "Can I self-host Cap's screen recordings?",
			answer:
				"Yes. Cap supports any S3-compatible storage provider, including AWS S3, Cloudflare R2, Backblaze B2, and self-hosted MinIO. Configure your own bucket in Cap's settings and your recordings are stored entirely within your infrastructure — Cap's servers never see your content.",
		},
		{
			question: "Is Cap's open source version free?",
			answer: `Yes. Cap's Studio Mode is completely free for personal use with no time limits and no watermarks. Instant Mode on the free plan supports recordings up to 5 minutes. Cap Pro ($${PRICING.pro.annualPerMonth}/month) removes Instant Mode time limits and adds team features. The core software will always be open source and free to use.`,
		},
		{
			question: "Can I contribute to Cap's development?",
			answer:
				"Absolutely. Cap welcomes contributions of all kinds — bug reports, feature requests, code contributions, and documentation improvements. Visit Cap's GitHub repository to file issues, browse open tasks, or submit a pull request. The roadmap is public and shaped by community feedback.",
		},
		{
			question: "Does Cap work on Mac and Windows?",
			answer:
				"Yes. Cap is available as a native desktop app for macOS and Windows. Both versions are included in the same open-source repository. <a href='/screen-recorder-mac'>Learn more about screen recording on Mac</a> or <a href='/screen-recorder-windows'>learn more about screen recording on Windows</a>.",
		},
		{
			question: "What license does Cap use?",
			answer:
				"Most Cap code is licensed under AGPLv3. The cap-camera* and scap-* Rust crate families are licensed under MIT. See the repository LICENSE for the terms that apply to each part of the project.",
		},
	],

	video: {},

	cta: {
		title: "Start Recording with the Best Open Source Screen Recorder",
		buttonText: "Download Cap Free",
		secondaryButtonText: "View on GitHub",
	},
};

export const OpenSourceScreenRecorderPage = () => {
	return <SeoPageTemplate content={openSourceScreenRecorderContent} />;
};
