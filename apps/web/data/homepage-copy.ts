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

export interface BentoCopy {
	eyebrow: string;
	title: string;
	subtitle: string;
	cards: {
		key: string;
		title: string;
		description: string;
	}[];
	cta: {
		label: string;
		href: string;
	};
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
	bento: BentoCopy;
	testimonials: TestimonialsCopy;
	pricing: PricingCopy;
	faq: FaqCopy;
	readyToGetStarted: ReadyToGetStartedCopy;
}

export const homepageCopy: HomePageCopy = {
	header: {
		announcement: {
			text: "Early Adopter Pricing Ends Soon — Lock In Your Discount",
			href: "/pricing",
		},
		variants: {
			default: {
				title: "Beautiful, Shareable Screen Recordings",
				description:
					"Cap is the open-source alternative to Loom — native, fast, and yours to control. Record locally with full editing power, or share instantly while you record. Bring your own S3 bucket, your own domain, your own rules.",
			},
		},
		cta: {
			primaryButton: "Upgrade to Cap Pro",
			secondaryButton: "Download",
			freeVersionText: "No credit card required. Get started for free.",
			seeOtherOptionsText: "More download options",
		},
	},
	textReveal: "Record. Edit. Share. — On Your Terms.",
	recordingModes: {
		title: "Three Modes, Zero Compromise",
		subtitle:
			"Instant Mode uploads as you record, so a shareable link is ready the moment you stop. Studio Mode keeps everything local for pixel-perfect editing. Screenshot, when a single frame is enough.",
		modes: [
			{
				name: "Instant Mode",
				description:
					"Hit record, stop, share link. Your video is live in seconds with auto-generated captions, a title, summary, chapters, and more. Perfect for quick feedback, bug reports, or when you just need to show something fast.",
			},
			{
				name: "Studio Mode",
				description:
					"Professional recordings with local editing, custom backgrounds, and export options. When you need pixel-perfect demos, tutorials, or presentations that represent your brand.",
			},
		],
	},
	features: {
		title: "Built For How You Actually Work",
		subtitle:
			"We obsessed over the details so you don't have to. Every feature is designed to save you time and make you look good.",
		features: [
			{
				title: "Your Storage, Your Rules",
				description:
					"Connect your own S3 bucket, use Cap Cloud, or keep everything local. You're never locked into our infrastructure — perfect for teams with compliance requirements or anyone who values data sovereignty.",
			},
			{
				title: "Privacy by Default, Sharing by Choice",
				description:
					"Instant sharing when you need it, local recording when you want it. Share publicly or privately, password-protect sensitive recordings, or keep them local only.",
			},
			{
				title: "Async Collaboration That Actually Works",
				description:
					'Comments, reactions, and transcripts keep conversations moving without another meeting. See who watched, get notified on feedback, and turn recordings into actionable next steps. Replace those "quick sync" calls for good.',
			},
			{
				title: "Cross-Platform For Your Entire Team",
				description:
					"Native apps for macOS and Windows that feel at home on each platform. No janky Electron apps or browser extensions — just fast, reliable recording that works with your existing tools and workflow.",
			},
			{
				title: "Quality That Makes You Look Professional",
				description:
					"4K recording, 60fps capture, and intelligent compression that keeps file sizes reasonable.",
			},
			{
				title: "Truly Open Source",
				description:
					"See exactly how Cap works, contribute features you need, or self-host for complete control. Join a community of builders who believe great tools should be transparent, extensible, and respect their users.",
			},
			{
				title: "Speed Up Your Workflow With Cap AI",
				description:
					"Auto-generated titles, summaries, clickable chapters, and transcriptions for every recording. AI features that actually save time instead of creating more work.",
			},
			{
				title: "Import Your Loom Videos",
				description:
					"Switching from Loom? Import your existing recordings directly into Cap with our built-in importer. Keep all your content in one place without starting from scratch.",
			},
		],
	},
	bento: {
		eyebrow: "Why Cap",
		title: "Built To Be Yours",
		subtitle:
			"Every feature respects how you actually work — your storage, your platform, your workflow. No vendor lock-in, no compromises.",
		cards: [
			{
				key: "storage",
				title: "Bring Your Own Storage",
				description:
					"Plug in your own S3 bucket, route to Cap Cloud, or keep recordings entirely local. Your videos, your bucket, your bill — no vendor lock-in, ever.",
			},
			{
				key: "ai",
				title: "Cap AI Does The Busywork",
				description:
					"Every recording gets an AI-generated title, summary, clickable chapters, and a fully searchable transcript — so the work after the recording is already done.",
			},
			{
				key: "async",
				title: "Async Conversations That Move",
				description:
					"Threaded comments, emoji reactions, and viewer analytics turn one-way videos into two-way conversations. Replace the standing meeting for good.",
			},
			{
				key: "native",
				title: "Native, Not An Electron Tab",
				description:
					"Built on Tauri and Rust for genuinely native performance on macOS and Windows. No bloated browser, no battery hit — just a fast, lightweight recorder.",
			},
			{
				key: "oss",
				title: "Open Source, End To End",
				description:
					"Inspect every line, contribute the feature you've been waiting for, or self-host the entire stack. Fair, transparent, and yours to fork.",
			},
			{
				key: "pixel",
				title: "Pixel-Perfect Capture",
				description:
					"Record up to 4K at 60fps with hardware-accelerated encoding. Crisp text, smooth motion, sane file sizes — the quality your work deserves.",
			},
		],
		cta: {
			label: "Explore Every Feature",
			href: "/features",
		},
	},
	testimonials: {
		title: "Loved By Builders, Trusted By Teams",
		subtitle:
			"Join thousands who've made Cap their daily driver for visual communication.",
		cta: "Read More Testimonials",
	},
	pricing: {
		title: "Simple, Honest Pricing",
		subtitle:
			"Start free, upgrade when you need more. Early adopter pricing locked in forever.",
		lovedBy: "Trusted by 30,000+ users",
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
			cta: "Get Started",
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
		title: "Questions? We've Got Answers.",
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
					"Native desktop apps for macOS (Apple Silicon & Intel) and Windows. View your shareable links from anywhere.",
			},
			{
				question: "Can I use Cap for commercial purposes?",
				answer:
					"Absolutely! Any paid plan (Desktop License or Cap Pro) includes full commercial usage rights. Use Cap for client work, sell courses, or embed recordings anywhere. The free version is for personal use only.",
			},
			{
				question: "Is my data secure?",
				answer:
					"Security is core to Cap. As an open source project, our code is fully auditable and transparent — you can see exactly how your data is handled. End-to-end encryption for cloud storage, option to use your own infrastructure, and community-driven security reviews keep your content safe.",
			},
			{
				question: "What about GDPR/HIPAA compliance?",
				answer:
					"Cap Pro supports custom S3 buckets in any region for GDPR compliance. For HIPAA and other regulations, our self-hosted option gives you complete control. We also offer signed BAAs for enterprise customers.",
			},
		],
	},
	readyToGetStarted: {
		title: "Ready To Upgrade How You Communicate?",
		buttons: {
			primary: "Upgrade to Cap Pro",
			secondary: "Download For Free",
		},
	},
};
