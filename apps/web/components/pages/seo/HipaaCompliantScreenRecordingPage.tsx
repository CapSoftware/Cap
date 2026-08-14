import { Clapperboard, Zap } from "lucide-react";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const hipaaCompliantScreenRecordingContent: SeoPageContent = {
	title: "HIPAA-Compliant Screen Recording for Healthcare Teams",
	description:
		"Cap is a HIPAA-compliant screen recorder for healthcare organizations. Sign a BAA and record with Cap Cloud, or self-host recordings on your own S3-compatible storage for complete control over PHI. Open-source and auditable.",

	badge: "HIPAA Compliant",

	featuresTitle: "Built for HIPAA-Compliant Screen Recording Workflows",
	featuresDescription:
		"Cap gives healthcare teams the recording capabilities they need with the data controls HIPAA requires",

	features: [
		{
			title: "HIPAA Compliant with Signed BAAs",
			description:
				"Cap is fully HIPAA compliant. We sign Business Associate Agreements with healthcare organizations, and every vendor in Cap's production infrastructure, from cloud storage to transcription, is covered by a BAA. Combined with SOC 2 Type II and ISO 27001, Cap Cloud is ready for PHI out of the box.",
		},
		{
			title: "Self-Hosted Storage — PHI Never Leaves Your Infrastructure",
			description:
				"Connect Cap to your own AWS S3 bucket, Cloudflare R2, or any S3-compatible storage. Recorded video files are uploaded directly to your infrastructure — no PHI ever touches Cap's servers. You maintain complete custody of all recorded data.",
		},
		{
			title: "Open-Source and Auditable",
			description:
				"Cap is MIT-licensed and fully open source on GitHub. Your security and compliance teams can audit every line of code. No black-box behavior, no undisclosed data collection — full transparency for your compliance reviews and vendor assessments.",
		},
		{
			title: "Access-Controlled Sharing",
			description:
				"Recordings shared via Cap links can be password-protected, restricting access to authorized personnel only. Combined with self-hosted storage, you control who can view recordings containing sensitive clinical content.",
		},
		{
			title: "No Third-Party Data Exposure",
			description:
				"With self-hosted storage, your recorded video and audio data travels from the desktop app directly to your S3 bucket. No recording content is processed or stored by third-party services outside your configured infrastructure.",
		},
		{
			title: "AWS S3 HIPAA-Eligible Storage",
			description:
				"Cap supports AWS S3, which is HIPAA-eligible under a BAA with Amazon. Configure Cap to use your existing HIPAA-covered AWS S3 bucket and your recordings stay within your established compliance boundary.",
		},
		{
			title: "Separate Screen and Webcam Tracks",
			description:
				"Studio Mode saves your screen recording and webcam as separate video tracks. This gives you precise control over what is stored, shared, or redacted — useful for recordings where on-screen PHI needs to be reviewed separately.",
		},
		{
			title: "AI Transcription Under Your Control",
			description:
				"Cap's AI captioning runs through a BAA-covered transcription provider, so captions are available even in regulated workflows. Auto-captions also remain fully optional: if your policies restrict any external audio processing, leave them disabled and the recording and sharing workflow functions fully without AI processing.",
		},
		{
			title: "Self-Hostable Platform",
			description:
				"The entire Cap platform — including the web dashboard and sharing layer — can be self-hosted on your own infrastructure. Run Cap completely within your network perimeter so no component of the system is outside your compliance controls.",
		},
	],

	recordingModes: {
		title: "Two Recording Modes for Healthcare Workflows",
		description:
			"Cap offers two modes to match different use cases — from quick clinical updates to structured medical training content",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode",
				description:
					"Record a clinical walkthrough or patient education video and get a shareable link immediately. Combined with self-hosted storage, the link points to your own S3 bucket — keeping the data within your HIPAA-covered environment. Free plan supports recordings up to 5 minutes.",
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
					"Completely free for personal use with no time limits. Records screen and webcam as separate tracks for post-production review and redaction. Ideal for medical education, EHR training content, and compliance documentation where editing control is required.",
			},
		],
	},

	comparisonTable: {
		title: "Cap vs Other Tools for HIPAA Screen Recording",
		headers: ["Feature", "Cap", "Loom", "Zoom", "Camtasia"],
		rows: [
			[
				"HIPAA compliant",
				{ text: "Yes, signed BAA", status: "positive" },
				{ text: "Enterprise only", status: "warning" },
				{ text: "BAA available", status: "warning" },
				{ text: "N/A", status: "neutral" },
			],
			[
				"Self-hosted storage",
				{ text: "Yes — any S3", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"Open-source code",
				{ text: "Yes — MIT", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"AWS S3 HIPAA support",
				{ text: "Yes — via your BAA", status: "positive" },
				{ text: "N/A", status: "neutral" },
				{ text: "BAA available", status: "warning" },
				{ text: "N/A", status: "neutral" },
			],
			[
				"PHI off third-party servers",
				{ text: "Yes — with self-hosting", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "Local only", status: "warning" },
			],
			[
				"AI captions optional",
				{ text: "Yes — can disable", status: "positive" },
				{ text: "Always on (paid)", status: "warning" },
				{ text: "Always on", status: "warning" },
				{ text: "Optional", status: "positive" },
			],
			[
				"Password-protected links",
				{ text: "Yes", status: "positive" },
				{ text: "Paid only", status: "warning" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
			],
			[
				"Fully self-hostable platform",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"Free for personal use",
				{ text: "Yes — Studio Mode", status: "positive" },
				{ text: "Limited", status: "warning" },
				{ text: "Limited", status: "warning" },
				{ text: "$299.99 one-time", status: "negative" },
			],
		],
	},

	comparisonTitle: "HIPAA-Compliant Recording Out of the Box",
	comparisonDescription:
		"Cap is HIPAA compliant with signed BAAs, and self-hosted storage gives healthcare teams even more control over where PHI lives",

	comparison: [
		{
			title: "Cap vs Loom for Healthcare",
			description:
				"Loom stores all recordings on Loom's servers with no option to self-host. For healthcare organizations handling PHI, this creates significant HIPAA risk. Cap with self-hosted storage keeps all recording data on infrastructure you control. <a href='/loom-alternative'>See the full Cap vs Loom comparison</a>.",
		},
		{
			title: "Cap vs Zoom for Recording",
			description:
				"Zoom offers HIPAA BAAs for video conferencing but stores cloud recordings on Zoom's infrastructure. Cap records asynchronously to your own S3 bucket — no third-party cloud storage required. Better suited for recorded training content, EHR walkthroughs, and async clinical communications.",
		},
		{
			title: "Cap for Medical Education Content",
			description:
				"Medical schools and hospitals use Cap to create EHR training walkthroughs, clinical procedure documentation, and compliance training. Studio Mode is free with no time limits, and self-hosted storage ensures training content with any clinical visuals stays on your infrastructure.",
		},
		{
			title: "Cap for Telehealth and Patient Education",
			description:
				"Record patient education videos and clinical walkthroughs with Cap. With self-hosted storage, video files never leave your AWS S3 or private cloud environment. Password-protected sharing links ensure only authorized patients and staff can access the content.",
		},
	],

	useCasesTitle: "HIPAA Screen Recording Use Cases",
	useCasesDescription:
		"Healthcare organizations use Cap for a range of workflows where data residency and access control matter",

	useCases: [
		{
			title: "EHR and Clinical Software Training",
			description:
				"Record walkthroughs of EHR systems, clinical workflows, and software tools for staff training. With self-hosted storage on AWS S3, all recorded content stays within your HIPAA-covered infrastructure. AI captions can be disabled if the training content includes any patient-visible information.",
		},
		{
			title: "Telehealth Workflow Documentation",
			description:
				"Document telehealth platform workflows, intake procedures, and patient communication protocols with screen recordings. Cap's async sharing model lets clinical staff review workflow documentation on their own schedule without requiring a live meeting.",
		},
		{
			title: "Compliance and Audit Documentation",
			description:
				"Record compliance training sessions, policy walkthroughs, and audit preparation content. Open-source code means your compliance team can verify exactly how data is handled. Self-hosted storage keeps all documentation within your established data governance controls.",
		},
		{
			title: "IT and Security Team Walkthroughs",
			description:
				"Healthcare IT teams use Cap to create internal security documentation, system configuration walkthroughs, and incident response training. Recordings are stored directly to your S3 bucket — no recording content traverses external networks.",
		},
		{
			title: "Patient Education Videos",
			description:
				"Create recorded patient education content — post-procedure care instructions, medication guides, and condition management walkthroughs. Password-protected Cap links restrict access to the intended patient, and self-hosted storage keeps video data in your environment.",
		},
		{
			title: "Medical Device and Software Demonstrations",
			description:
				"Medical device companies and health IT vendors use Cap to record product demonstrations and training content for healthcare clients. Open-source code simplifies vendor security reviews, and self-hosted storage satisfies healthcare customer data requirements.",
		},
	],

	migrationGuide: {
		title: "How to Set Up HIPAA-Compliant Screen Recording with Cap",
		steps: [
			"Fastest path: use Cap Cloud under a signed BAA. Contact the Cap team via cap.so/support to get your BAA executed, then record and share as normal",
			"Prefer self-hosted storage? Create a HIPAA-eligible AWS S3 bucket in your AWS account — ensure your AWS account is covered by an AWS BAA",
			"Configure Cap's storage settings to point to your AWS S3 bucket using your AWS access key and secret",
			"Download Cap for Mac or Windows — installation takes under 2 minutes",
			"Disable AI auto-captions in Cap settings if your HIPAA policy restricts external audio transcription",
			"Test a recording — stop recording and verify the file appears in your S3 bucket, not Cap's storage",
			"Configure password protection on shared links for any recordings containing clinical content",
			"For full platform control, deploy the Cap self-hosted web application within your own infrastructure",
		],
	},

	faqsTitle:
		"Frequently Asked Questions About HIPAA-Compliant Screen Recording",
	faqs: [
		{
			question: "Can Cap be used for HIPAA-compliant screen recording?",
			answer:
				"Yes. Cap is HIPAA compliant. We sign Business Associate Agreements (BAAs) with healthcare organizations, and every vendor in Cap's production infrastructure is covered by a BAA. For teams that want additional control, Cap also supports self-hosted storage: connect your own AWS S3 bucket (covered under your AWS BAA) and all recorded video files are stored on your infrastructure rather than Cap's servers.",
		},
		{
			question: "Does Cap store recordings on its own servers?",
			answer:
				"By default, Cap uploads recordings to Cap's cloud storage, which is HIPAA compliant and covered by BAAs with every infrastructure vendor. Cap also fully supports custom S3-compatible storage — connect your own AWS S3, Cloudflare R2, or private MinIO instance and all recordings go directly to your bucket. With self-hosted storage enabled, no recording data touches Cap's infrastructure.",
		},
		{
			question:
				"Is Cap open source and auditable for HIPAA vendor assessments?",
			answer:
				"Yes. Cap is MIT-licensed and fully open source on GitHub. Your security and compliance teams can audit the complete source code to verify data handling behavior, network calls, and storage logic. This transparency simplifies HIPAA vendor security reviews compared to closed-source recording tools.",
		},
		{
			question: "Can I disable AI transcription in Cap for HIPAA compliance?",
			answer:
				"Yes. Cap's AI auto-captions are optional and can be disabled entirely in settings. Cap Cloud transcription runs through a BAA-covered provider, so captions are available even in regulated workflows. If your HIPAA policies restrict any external audio processing, simply leave auto-captions off and Cap's core recording, uploading, and sharing workflow operates fully without AI processing.",
		},
		{
			question: "Does Cap support AWS S3 for HIPAA-eligible storage?",
			answer:
				"Yes. Cap supports AWS S3 as a storage backend. AWS S3 is HIPAA-eligible when covered by an AWS Business Associate Agreement (BAA). Configure Cap with your AWS S3 bucket credentials and all recordings upload directly to your HIPAA-covered bucket. Your data never passes through Cap's storage.",
		},
		{
			question: "Can the entire Cap platform be self-hosted?",
			answer:
				"Yes. The complete Cap platform — including the web dashboard, sharing layer, and API — can be self-hosted on your own infrastructure. For healthcare organizations requiring full network perimeter control, self-hosting eliminates any reliance on Cap's cloud services. See Cap's self-hosting documentation for deployment instructions.",
		},
		{
			question:
				"How do I restrict access to HIPAA screen recordings shared via Cap?",
			answer:
				"Cap supports password-protected sharing links. Enable password protection on any recording and only viewers with the password can access it. Combined with self-hosted storage, this ensures recording content remains on your infrastructure and access is restricted to authorized personnel.",
		},
		{
			question: "What screen recording tools are HIPAA-compliant?",
			answer:
				"Cap is HIPAA compliant, with signed BAAs available and a fully auditable open-source codebase. Tools that only offer cloud storage on the vendor's servers, like standard Loom, restrict HIPAA support to enterprise plans and require additional vendor review. Local-only recorders like Camtasia avoid cloud storage entirely but lack Cap's async sharing capabilities. Cap also supports self-hosted S3 storage for teams that want recordings to stay entirely within their own infrastructure.",
		},
	],

	video: {
		iframe: {
			src: "https://www.rend.so/embed/10512af0-b922-4efa-8974-f8f14fc1886a?accent=3e63dd",
			title: "Cap HIPAA-compliant screen recording demo showing self-hosted storage configuration and secure sharing",
		},
	},

	cta: {
		title: "Start HIPAA-Compliant Screen Recording with Cap",
		buttonText: "Download Cap Free",
		secondaryButtonText: "View Self-Hosting Docs",
	},
};

export const HipaaCompliantScreenRecordingPage = () => {
	return <SeoPageTemplate content={hipaaCompliantScreenRecordingContent} />;
};
