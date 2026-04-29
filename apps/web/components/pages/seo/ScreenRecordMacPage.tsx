"use client";

import Script from "next/script";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";

export const screenRecordMacContent = {
	title: "Best Screen Recorder for Mac | High-Quality, Free & Easy (2025)",
	description:
		"Cap is the best free screen recorder for Mac, offering HD quality, unlimited recording, and easy export. Ideal for tutorials, presentations, and educational videos.",

	featuresTitle: "Why Cap is the Best Screen Recorder for Mac",
	featuresDescription:
		"Cap provides all the features Mac users need for stunning, high-quality screen recordings",

	features: [
		{
			title: "Optimized for macOS",
			description:
				"Cap is fully optimized for Mac, delivering smooth performance and seamless integration with macOS. Looking for a <a href='/free-screen-recorder'>free screen recorder for Mac</a>? Cap is your best choice!",
		},
		{
			title: "High-Quality Video Capture",
			description:
				"Record clear, high-definition video with synced audio, perfect for professional use. Experience why users rate Cap as the best screen recorder for Mac.",
		},
		{
			title: "User-Friendly Interface",
			description:
				"Designed for ease of use on Mac, Cap offers an intuitive setup and simple recording options. Follow our <a href='/how-to-screen-record'>step-by-step screen recording guide</a> to start capturing your screen in minutes.",
		},
		{
			title: "Unlimited Recording Time",
			description:
				"Record for as long as you need with no restrictions on recording time, ideal for extended presentations.",
		},
		{
			title: "Easy Export and Sharing",
			description:
				"Save and share your recordings effortlessly with Cap's built-in export options for Mac.",
		},
		{
			title: "Professional Tools",
			description:
				"Access professional <a href='/screen-recording-software'>screen recording software</a> features optimized for Mac. A perfect <a href='/loom-alternative'>Loom alternative for Mac</a> users.",
		},
	],

	useCasesTitle: "Popular Uses for the Best Screen Recorder for Mac",
	useCasesDescription:
		"Explore how Cap's screen recorder enhances productivity on macOS",

	useCases: [
		{
			title: "Creating Tutorials",
			description:
				"Easily create detailed tutorials or training videos on your Mac using our <a href='/screen-recorder'>professional Mac recording software</a>.",
		},
		{
			title: "Professional Presentations",
			description:
				"Record high-quality presentations and demos to share with colleagues or clients.",
		},
		{
			title: "Educational Content",
			description:
				"Develop engaging educational videos or lectures for students or training materials.",
		},
		{
			title: "Remote Team Collaboration",
			description:
				"Share recorded screen content with your team to facilitate remote feedback and collaboration.",
		},
	],

	faqsTitle: "Frequently Asked Questions",
	faqs: [
		{
			question: "Is Cap compatible with macOS?",
			answer:
				"Yes, Cap is fully compatible with macOS and optimized to work seamlessly on Mac devices. If you're looking for a <a href='/free-screen-recorder'>free screen recorder</a>, Cap is perfect for Mac users.",
		},
		{
			question: "Can I record my screen with audio on Mac?",
			answer:
				"Yes, Cap allows you to record high-quality screen videos with audio, making it perfect for presentations and tutorials.",
		},
		{
			question: "How do I export recordings from Cap on my Mac?",
			answer:
				"Cap offers easy export options, allowing you to save your recordings in various formats directly from your Mac.",
		},
		{
			question: "Can I use Cap for free on Mac?",
			answer:
				"Yes, Cap offers a free version with powerful features for Mac users, including unlimited recording time and high-quality video capture.",
		},
		{
			question: "What are the best uses for Cap on Mac?",
			answer:
				"Cap is ideal for creating tutorials, recording presentations, producing educational content, and supporting remote collaboration.",
		},
	],

	video: {
		url: "/videos/cap-mac-screen-recorder-demo.mp4",
		thumbnail: "/videos/cap-mac-screen-recorder-thumbnail.png",
		alt: "Cap screen recorder demo on macOS showing high-quality recording",
	},

	cta: {
		title: "Get Started with Cap – The Best Screen Recorder for Mac",
		buttonText: "Download Cap Free for Mac",
	},
};

// Create FAQ structured data for SEO
const createFaqStructuredData = () => {
	const faqStructuredData = {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: screenRecordMacContent.faqs.map((faq) => ({
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

export const ScreenRecordMacPage = () => {
	return (
		<>
			<Script
				id="faq-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: createFaqStructuredData() }}
			/>
			<SeoPageTemplate content={screenRecordMacContent} />
		</>
	);
};
