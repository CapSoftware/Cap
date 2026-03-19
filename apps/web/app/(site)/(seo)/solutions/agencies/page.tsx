import type { Metadata } from "next";
import Script from "next/script";
import { AgenciesPage } from "@/components/pages/seo/AgenciesPage";

// Create FAQ structured data for SEO
const createFaqStructuredData = () => {
	const faqs = [
		{
			question: "Does Cap work on both macOS and Windows?",
			answer:
				"Yes. Cap supports both macOS and Windows with desktop apps, so your entire team can use the same workflow regardless of their platform preference.",
		},
		{
			question: "Can clients view videos without installing anything?",
			answer:
				"Yes. Clients can watch videos directly in their browser through a simple link. No downloads, no account creation, no friction. They can also leave comments directly on the video.",
		},
		{
			question: "What's the difference between Instant Mode and Studio Mode?",
			answer:
				"Instant Mode generates a shareable link immediately after recording—perfect for quick updates. Studio Mode records locally for the highest quality and includes precision editing tools for professional client presentations.",
		},
		{
			question: "How long can we record on the free version?",
			answer:
				"The free version supports recordings up to 5 minutes. For longer client presentations and unlimited recording time, upgrade to Cap Pro at $8.16/month (billed annually).",
		},
		{
			question: "Is Cap secure enough for confidential client work?",
			answer:
				"Yes. Cap is open-source and privacy-first. You can connect your own S3 storage, use a custom domain for share links, and password-protect sensitive videos. This gives you complete control over client data.",
		},
		{
			question: "Can we use our own branding with Cap?",
			answer:
				"Yes. Cap Pro includes custom domain support (cap.yourdomain.com) so share links reflect your agency's brand. You can also use your own S3 storage for complete data ownership.",
		},
		{
			question: "How does Cap pricing work for agency teams?",
			answer:
				"Cap Pro is $8.16/month per user (billed annually) and includes unlimited cloud storage, custom domains, team workspaces, and all collaboration features. Volume discounts are available for teams over 10 users.",
		},
	];

	const faqStructuredData = {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: faqs.map((faq) => ({
			"@type": "Question",
			name: faq.question,
			acceptedAnswer: {
				"@type": "Answer",
				text: faq.answer.replace(/<\/?[^>]+(>|$)/g, ""),
			},
		})),
	};

	return JSON.stringify(faqStructuredData);
};

// Create SoftwareApplication structured data
const createSoftwareStructuredData = () => {
	const softwareStructuredData = {
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: "Cap — Screen Recorder",
		operatingSystem: ["macOS", "Windows"],
		applicationCategory: "BusinessApplication",
		description:
			"Open-source, privacy-first screen recorder for agencies. Instant share links and studio-quality local recording with editing.",
		publisher: {
			"@type": "Organization",
			name: "Cap",
		},
		offers: {
			"@type": "Offer",
			price: "0",
			priceCurrency: "USD",
			category: "FreeTrial",
		},
	};

	return JSON.stringify(softwareStructuredData);
};

export const metadata: Metadata = {
	title: "Cap for Agencies — Faster Client Updates with Instant Video Links",
	description:
		"Send clearer client updates in minutes. Share instant links with comments, or craft polished walkthroughs. Cap for Agencies on macOS & Windows.",
	openGraph: {
		title: "Cap for Agencies — Faster Client Updates with Instant Video Links",
		description:
			"Send clearer client updates in minutes. Share instant links with comments, or craft polished walkthroughs. Cap for Agencies on macOS & Windows.",
		url: "https://cap.so/solutions/agencies",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap for Agencies",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Cap for Agencies — Faster Client Updates with Instant Video Links",
		description:
			"Send clearer client updates in minutes. Share instant links with comments, or craft polished walkthroughs. Cap for Agencies on macOS & Windows.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/solutions/agencies",
	},
};

export default function Page() {
	return (
		<>
			<Script
				id="faq-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: createFaqStructuredData() }}
			/>
			<Script
				id="software-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: createSoftwareStructuredData() }}
			/>
			<AgenciesPage />
		</>
	);
}
