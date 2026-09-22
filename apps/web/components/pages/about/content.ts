import type { ModeKey } from "@/components/pages/HomeTwo/theme";

export const GITHUB_URL = "https://github.com/CapSoftware/Cap";

export const DISCORD_URL = "https://discord.gg/y8gdQ3WRN3";

export const X_URL = "https://x.com/cap";

export const story = [
	{
		label: "The problem",
		paragraphs: [
			"Screen recording should be one of the simplest things you do on a computer. Hit record, capture your screen, share it. That is the whole workflow.",
			"But the tools most people use are closed source, loaded with tracking, and designed to lock your content into proprietary systems. Your recordings live on someone else's servers, under someone else's terms. You cannot self-host, you cannot inspect the code, and you cannot export your data without jumping through hoops.",
			"Most recording tools are built by large companies optimising for revenue, not for users. They are slow to improve, ignore community feedback, and add complexity where there should be clarity. The result is software that feels heavy, invasive, and out of your control.",
		],
	},
	{
		label: "The idea",
		paragraphs: [
			"We did not set out to build another screen recorder. We wanted to build the one that should have always existed. One that respects your privacy, works beautifully, and gives you full ownership of everything you create.",
			"Cap is built around a simple principle: your recordings are yours. You should be able to record, edit, and share without sacrificing privacy or flexibility. Whether you are explaining a bug, walking through a design, or recording a demo, the tool should get out of your way.",
			"So we built Cap as a native desktop app with a powerful web companion. Record in Instant Mode for quick shares, or use Studio Mode for high fidelity captures with separate screen and camera tracks. Add captions, zooms, and backgrounds, then share with a single link or export however you want.",
		],
	},
] as const;

export type Principle = {
	title: string;
	body: string;
	mode: ModeKey;
	link?: { label: string; href: string };
};

export const principles: Principle[] = [
	{
		title: "Open source, by design",
		body: "Cap is fully open source under the AGPL license. Every line of code, from the Rust recording engine to the web sharing platform, is public and auditable. This is not a marketing decision. It is a belief about how software should be built.",
		mode: "instant",
		link: { label: "View on GitHub", href: GITHUB_URL },
	},
	{
		title: "Privacy as a feature",
		body: "Privacy is not a checkbox on our features page. It is the foundation of everything we build. Cap does not track you, does not sell your data, and does not require you to use our servers.",
		mode: "studio",
	},
	{
		title: "Your recordings are yours",
		body: "Connect your own S3 compatible storage or Google Drive and keep every recording on infrastructure you control. Self-host the entire platform if you want to. No vendor lock in, no data held hostage, no surprises.",
		mode: "screenshot",
	},
	{
		title: "Built with the community",
		body: "Features are shaped by real users, not boardroom decisions. Open roadmap, open issues, open conversations. When closed tools change their pricing or shut down, workflows break. With Cap, you can fork the code or trust the thousands of developers watching it.",
		mode: "share",
	},
];

export type Milestone = {
	date: string;
	title: string;
	body: string;
	href?: string;
	external?: boolean;
};

export const milestones: Milestone[] = [
	{
		date: "Nov 2023",
		title: "First commit",
		body: "Cap starts life on GitHub as an open source alternative to Loom.",
		href: GITHUB_URL,
		external: true,
	},
	{
		date: "Apr 2024",
		title: "Public beta",
		body: "After six months of development, Cap launches publicly to anyone who wants to try it.",
		href: "/blog/cap-public-beta-launch",
	},
	{
		date: "Sep 2024",
		title: "Cap v0.3",
		body: "Rebuilt from the ground up as a local first app with editing, one click sharing, and screenshots.",
		href: "/blog/cap-v03-launch",
	},
	{
		date: "May 2026",
		title: "Cap v0.5",
		body: "Google Drive storage, merged recordings, screenshot OCR, camera background blur, and a sturdier recorder.",
		href: "/blog/cap-v05",
	},
	{
		date: "Aug 2026",
		title: "SOC 2 Type II, ISO 27001, and HIPAA",
		body: "Independently audited controls behind Cap Cloud, and signed BAAs for teams handling health data.",
		href: "/blog/soc2-type-ii-iso-27001",
	},
	{
		date: "Sep 2026",
		title: "Cap v0.6",
		body: "A redesigned editor, 3D scenes, animated text, Studio Sound, and a first look at the native GPUI app.",
		href: "/blog/cap-v06",
	},
];

export const focus = [
	{
		label: "Speed and simplicity",
		body: "Recording and sharing should take seconds, not minutes. No bloat, no unnecessary steps.",
	},
	{
		label: "Beautiful output",
		body: "Automatic captions, smooth zooms, and polished share pages that make your recordings look professional.",
	},
	{
		label: "Full data ownership",
		body: "Self-host the platform, connect your own storage, or use our cloud. The choice is always yours.",
	},
	{
		label: "Community driven",
		body: "Features shaped by real users. Open roadmap, open issues, open conversations.",
	},
] as const;

export const quote = {
	name: "Steven Tey",
	handle: "Founder, Dub.co",
	image: "/testimonials/steven_tey.jpg",
	content:
		"Cap is one of my favorite pieces of software I've used in the recent years. Best part is you get to own your data since they're fully open-source + via their S3 integration.",
	url: "https://www.producthunt.com/products/cap-3?comment=4174427#cap-4",
} as const;
