"use client";

import Link from "next/link";
import { PRICING } from "@/data/pricing";

interface FaqItem {
	title: string;
	answer: string;
	link?: {
		text: string;
		href: string;
	};
}

const faqContent: FaqItem[] = [
	{
		title: "Who is Cap for?",
		answer:
			"Cap is for anyone who wants to record, edit, and share videos. It's a lightweight, powerful tool for creators, educators, marketers, developers, and remote teams who want to communicate more effectively through screen recordings.",
	},
	{
		title: "How much does it cost?",
		answer: `Cap offers a free version for personal use. You can upgrade to Cap Pro for just $${PRICING.pro.annualPerMonth}/month (when billed annually) to unlock unlimited cloud storage, unlimited recording length, custom domain support, advanced team features, password-protected videos, analytics, and priority support. We also offer commercial licenses and self-hosted options for businesses.`,
	},
	{
		title: "Which platforms does Cap support?",
		answer:
			"Cap is cross-platform. There are native desktop apps for macOS (both Apple Silicon and Intel), Windows and Linux, plus a Google Chrome extension and a web recorder that runs straight from your browser. For macOS, we recommend version 13.1 or newer. For Windows, we recommend Windows 10 or newer.",
	},
	{
		title: "What makes Cap different from Loom?",
		answer:
			"Cap is open source, privacy-focused, and lets you own your data. You can connect your own Google Drive or custom S3 storage buckets, self-host the entire platform, and get a lightweight, faster experience. We focus strongly on design, user experience, and building with our community at the center of everything we do. Plus, our built-in Loom video importer makes switching effortless.",
	},
	{
		title: "Can I import my Loom videos to Cap?",
		answer:
			"Yes! Cap Pro includes a built-in Loom video importer that lets you seamlessly transfer your existing Loom recordings into Cap. Just paste your Loom video links and Cap handles the rest — keeping all your content organized in one place.",
	},
	{
		title: "Can I self-host Cap?",
		answer:
			"Yes! Cap can be self-hosted on your own infrastructure, giving you full control over your data.",
	},
	{
		title: "Is Cap SOC 2 compliant?",
		answer:
			"Yes. Cap is SOC 2 Type II, ISO 27001, and HIPAA compliant. You can request our reports and view our security practices in Cap's Trust Portal.",
		link: {
			text: "Visit the Trust Portal",
			href: "https://trust.cap.so",
		},
	},
	{
		title: "Is Cap HIPAA compliant?",
		answer:
			"Yes. Cap is fully HIPAA compliant. We sign Business Associate Agreements (BAAs) with organizations handling protected health information, and every vendor in Cap's production infrastructure is covered by a BAA. For even more control, you can bring your own storage or self-host Cap entirely.",
		link: {
			text: "Learn about HIPAA-compliant recording",
			href: "/hipaa-compliant-screen-recording",
		},
	},
	{
		title: "Is there a commercial license available?",
		answer:
			"Yes, we offer commercial licenses for businesses that want to use the Cap desktop app. The commercial license includes the Cap Recorder + Editor with local-only features. Our Pro plan also includes a commercial license for the desktop app.",
		link: {
			text: "Deactivate your license",
			href: "/deactivate-license",
		},
	},
	{
		title: "What happens after the beta period ends?",
		answer:
			"Early adopters will keep their special pricing for the lifetime of their subscription, even after we move out of beta and adjust our regular pricing. This is our way of thanking our early supporters.",
	},
];

export const FaqPage = () => {
	return (
		<div className="py-32 md:py-40 wrapper wrapper-sm">
			<div className="mb-14 text-center page-intro">
				<h1>FAQ</h1>
			</div>
			<div className="mb-10">
				{faqContent.map((section) => {
					return (
						<div key={section.title} className="mx-auto my-8 max-w-2xl">
							<h2 className="mb-2 text-xl">{section.title}</h2>
							<p className="text-lg">{section.answer}</p>
							{section.link && (
								<Link
									href={section.link.href}
									className="inline-block mt-2 text-blue-500 hover:text-blue-600 hover:underline"
								>
									{section.link.text} &rarr;
								</Link>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
};
