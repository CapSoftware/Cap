export interface HeaderCopyVariants {
	default: {
		title: string;
		description: string;
	};
}

export interface HeaderCopy {
	announcement: {
		text: string;
		href: string;
	};
	variants: HeaderCopyVariants;
	cta: {
		primaryButton: string;
		secondaryButton: string;
		freeVersionText: string;
		seeOtherOptionsText: string;
	};
}

export interface RecordingModesCopy {
	title: string;
	subtitle: string;
	modes: {
		name: string;
		description: string;
	}[];
}

export interface FeaturesCopy {
	title: string;
	subtitle: string;
	features: {
		title: string;
		description: string;
	}[];
}

export interface TestimonialsCopy {
	title: string;
	subtitle: string;
	cta: string;
}

export interface PricingCopy {
	title: string;
	subtitle: string;
	lovedBy: string;
	commercial: {
		title: string;
		description: string;
		features: string[];
		cta: string;
		pricing: {
			yearly: number;
			lifetime: number;
		};
		labels: {
			licenses: string;
			yearly: string;
			lifetime: string;
		};
	};
	pro: {
		badge: string;
		title: string;
		description: string;
		features: string[];
		cta: string;
		pricing: {
			annual: number;
			monthly: number;
		};
		labels: {
			users: string;
			monthly: string;
			annually: string;
		};
	};
}

export interface FaqCopy {
	title: string;
	items: {
		question: string;
		answer: string;
	}[];
}

export interface ReadyToGetStartedCopy {
	title: string;
	buttons: {
		primary: string;
		secondary: string;
	};
}

export interface HomePageCopy {
	header: HeaderCopy;
	textReveal: string;
	recordingModes: RecordingModesCopy;
	features: FeaturesCopy;
	testimonials: TestimonialsCopy;
	pricing: PricingCopy;
	faq: FaqCopy;
	readyToGetStarted: ReadyToGetStartedCopy;
}

export const homepageCopy: HomePageCopy = {
	header: {
		announcement: {
			text: "🚨 Early Adopter Pricing Ends Soon - Lock In Your Discount",
			href: "/pricing",
		},
		variants: {
			default: {
				title: "Beautiful, shareable screen recordings",
				description:
					"Cap is the open source alternative to Loom. Lightweight, powerful, and cross-platform. Record and share securely in seconds with custom S3 bucket support. Connect your own domain.",
			},
		},
		cta: {
			primaryButton: "Upgrade to Cap Pro",
			secondaryButton: "Download",
			freeVersionText: "No credit card required. Get started for free.",
			seeOtherOptionsText: "More download options",
		},
	},
	textReveal: "Record. Edit. Share.",
	recordingModes: {
		title: "Share instantly, or record and edit locally",
		subtitle:
			"Instant Mode bypasses rendering with real-time uploading whilst you are recording. Studio Mode prioritizes quality with local recording and full editing capabilities.",
		modes: [
			{
				name: "Instant Mode",
				description:
					"Hit record, stop, share link. Your video is live in seconds with automatically generated captions, a title, summary, chapters, and more. Perfect for quick feedback, bug reports, or when you just need to show something fast.",
			},
			{
				name: "Studio Mode",
				description:
					"Professional recordings with local editing, custom backgrounds, and export options. When you need pixel-perfect demos, tutorials, or presentations that represent your brand.",
			},
		],
	},
	features: {
		title: "Built for how you actually work",
		subtitle:
			"We obsessed over the details so you don't have to. Every feature is designed to save you time and make you look good.",
		features: [
			{
				title: "Your storage, your rules",
				description:
					"Connect your own S3 bucket, use our cloud, or keep everything local. Unlike other tools, you're never locked into our infrastructure. Perfect for teams with compliance requirements or those who value data sovereignty.",
			},
			{
				title: "Privacy by default, sharing by choice",
				description:
					"Instant sharing when you need it, local recording when you want it. Share publicly or privately. Password protect sensitive recordings or keep them local only.",
			},
			{
				title: "Async collaboration that actually works",
				description:
					'Comments, reactions, and transcripts keep conversations moving without another meeting. See who watched, get notified on feedback, and turn recordings into actionable next steps. Replace those "quick sync" calls for good.',
			},
			{
				title: "Cross-platform for your entire team",
				description:
					"Native apps for macOS and Windows that feel at home on each platform. No janky Electron apps or browser extensions. Just fast, reliable recording that works with your existing tools and workflow.",
			},
			{
				title: "Quality that makes you look professional",
				description:
					"4K recording, 60fps capture, and intelligent compression that keeps file sizes reasonable.",
			},
			{
				title: "Truly open source",
				description:
					"See exactly how Cap works, contribute features you need, or self-host for complete control. Join a community of builders who believe great tools should be transparent, extensible, and respect their users.",
			},
			{
				title: "Speed up your workflow with Cap AI",
				description:
					"Auto-generated titles, summaries, clickable chapters, and transcriptions for every recording. AI features that actually save time instead of creating more work.",
			},
			{
				title: "Import your Loom videos",
				description:
					"Switching from Loom? Import your existing Loom recordings directly into Cap with our built-in video importer. Keep all your content in one place without starting from scratch.",
			},
		],
	},
	testimonials: {
		title: "Loved by builders, trusted by teams",
		subtitle:
			"Join thousands who've made Cap their daily driver for visual communication.",
		cta: "Read more testimonials",
	},
	pricing: {
		title: "Simple, honest pricing",
		subtitle:
			"Start free, upgrade when you need more. Early adopter pricing locked in forever.",
		lovedBy: "Trusted by 10,000+ users",
		commercial: {
			title: "Desktop License",
			description:
				"For professionals who want unlimited local recording and editing.",
			features: [
				"Commercial usage",
				"Unlimited local recordings",
				"Studio Mode with full editor",
				"Export to any format",
				"Community support",
			],
			cta: "Get Desktop License",
			pricing: {
				yearly: 29,
				lifetime: 58,
			},
			labels: {
				licenses: "License type",
				yearly: "Annual",
				lifetime: "One-time",
			},
		},
		pro: {
			badge: "Best value",
			title: "Cap Pro",
			description:
				"Everything in Desktop plus unlimited cloud features for seamless sharing and collaboration.",
			features: [
				"Everything in Desktop License",
				"Unlimited cloud storage & bandwidth",
				"Auto-generated titles, summaries, clickable chapters, and transcriptions for every recording",
				"Custom domain (cap.yourdomain.com)",
				"Password protected shares",
				"Viewer analytics & engagement",
				"Team workspaces",
				"Loom video importer",
				"Custom S3 bucket support",
				"Priority support & early features",
			],
			cta: "Get started",
			pricing: {
				annual: 8.16,
				monthly: 12,
			},
			labels: {
				users: "Per user",
				monthly: "Monthly",
				annually: "Annual (save 32%)",
			},
		},
	},
	faq: {
		title: "Questions? We've got answers.",
		items: [
			{
				question: "What is the difference between Cap Pro and Desktop License?",
				answer:
					"Cap Pro is a paid plan that includes all the features of the Desktop License plus cloud features for seamless sharing and collaboration. Desktop License grants you commercial usage rights for a single user.",
			},
			{
				question: "Is there a free version?",
				answer:
					"Yes! Cap is 100% free for personal use. You can record and share locally with Studio Mode. A paid plan is required for commercial usage.",
			},
			{
				question: "How long can I record for on the free version?",
				answer:
					"You can record for 5 minutes on the free version. After that, you'll need to upgrade to a paid plan.",
			},
			{
				question: "How does Cap AI work?",
				answer:
					"Cap AI is a powerful tool that can be used to generate titles, summaries, clickable chapters, and transcriptions for your recordings. It's available for all Cap Pro users and has no usage limits.",
			},
			{
				question: "How is Cap different from Loom?",
				answer:
					"Cap gives you the best of both worlds: the simplicity of Loom with the power of professional tools. We're open source, support custom storage, offer better pricing, and our desktop app works offline. Plus, you actually own your content. Already using Loom? Our built-in Loom video importer makes switching effortless.",
			},
			{
				question: "What happens to my recordings if I cancel?",
				answer:
					"Your recordings are yours forever. If you cancel Pro, existing shares remain active and you can always export everything. Downgrade to our free plan to keep recording locally, or self-host to maintain all features.",
			},
			{
				question: "Do you offer team plans?",
				answer:
					"Yes! Cap Pro includes team workspaces where you can organize recordings, manage permissions, and collaborate. Volume discounts available for teams over 10 users. Contact us for custom enterprise features.",
			},
			{
				question: "Which platforms do you support?",
				answer:
					"Native desktop apps for macOS (Apple Silicon & Intel) and Windows. View your shareable linkes from anywhere.",
			},
			{
				question: "Can I use Cap for commercial purposes?",
				answer:
					"Absolutely! Any paid plan (Desktop License or Cap Pro) includes full commercial usage rights. Use Cap for client work, sell courses, or embed recordings anywhere. The free version is for personal use only.",
			},
			{
				question: "Is my data secure?",
				answer:
					"Security is core to Cap. As an open source project, our code is fully auditable and transparent - you can see exactly how your data is handled. End-to-end encryption for cloud storage, option to use your own infrastructure, and community-driven security reviews keep your content safe.",
			},
			{
				question: "What about GDPR/HIPAA compliance?",
				answer:
					"Cap Pro supports custom S3 buckets in any region for GDPR compliance. For HIPAA and other regulations, our self-hosted option gives you complete control. We also offer signed BAAs for enterprise customers.",
			},
		],
	},
	readyToGetStarted: {
		title: "Ready to upgrade how you communicate?",
		buttons: {
			primary: "Upgrade to Cap Pro",
			secondary: "Download for free",
		},
	},
};
