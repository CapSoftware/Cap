"use client";

import { SeoPageTemplate } from "../../seo/SeoPageTemplate";

export const freeScreenRecorderContent = {
	title: "Free Screen Recorder: High-Quality Recording at No Cost",
	description:
		"Cap offers a top-rated, free screen recorder with high-quality video capture, making it perfect for creating tutorials, educational content, and professional demos without any hidden fees.",

	featuresTitle: "Why Choose Cap's Free Screen Recorder?",
	featuresDescription:
		"Cap provides all the tools you need for powerful, no-cost screen recording",

	features: [
		{
			title: "Professional-Grade Software",
			description:
				"Get access to professional <a href='/screen-recording-software'>screen recording software</a> features completely free.",
		},
		{
			title: "High-Quality Video Capture",
			description:
				"Record smooth, clear video with high frame rates and top audio quality, even on the free plan.",
		},
		{
			title: "User-Friendly Interface",
			description:
				"Designed for ease of use, Cap makes it simple to record your screen in just a few clicks.",
		},
		{
			title: "Unlimited Recording Time",
			description:
				"Record for as long as you need with no restrictions on recording time.",
		},
		{
			title: "Unlimited Cloud Storage",
			description:
				"Securely store and access your recordings anytime with unlimited cloud storage.",
		},
	],

	useCasesTitle: "Popular Uses for Cap's Free Screen Recorder",
	useCasesDescription:
		"Explore how Cap can support your recording needs, all at no cost",

	useCases: [
		{
			title: "Creating Tutorials",
			description:
				"Easily record and share tutorials without paying for premium-priced recording software. Works great as a <a href='/screen-recorder-windows'>free Windows screen recorder</a> and on Mac.",
		},
		{
			title: "Professional Presentations",
			description:
				"Capture high-quality presentations and demos using our powerful <a href='/screen-recorder'>screen recording software</a> to share with clients and colleagues.",
		},
		{
			title: "Educational Content",
			description:
				"Produce educational videos or training materials for students or team members at no cost.",
		},
		{
			title: "Feedback and Collaboration",
			description:
				"Share recorded content with your team for feedback, collaboration, or future reference.",
		},
	],

	faqsTitle: "Frequently Asked Questions",
	faqs: [
		{
			question: "Is Cap really free?",
			answer:
				"Yes, Cap is completely free, with no hidden fees. You get access to professional-grade <a href='/screen-recorder'>screen recording</a> tools without a subscription.",
		},
		{
			question: "How long can I record for on the free plan?",
			answer:
				"Cap's free plan allows for unlimited recording time, so you can capture your screen without interruptions. Whether you're on <a href='/screen-recorder-mac'>Mac</a> or <a href='/screen-recorder-windows'>Windows</a>, there are no time limits.",
		},
		{
			question: "Can I store my recordings in the cloud?",
			answer:
				"Yes, from just $6/month, Cap offers unlimited cloud storage, making it easy to access and share recordings whenever needed.",
		},
		{
			question: "What makes Cap's free screen recorder different?",
			answer:
				"Cap offers advanced features for free, such as high-quality video capture, easy sharing options, and an intuitive interface, making it ideal for professional use without any cost.",
		},
		{
			question: "Do I need an account to use Cap's free screen recorder?",
			answer:
				"Yes, creating a free account allows you to access Cap 100% free locally.",
		},
	],

	video: {
		url: "/videos/cap-free-screen-recorder-demo.mp4",
		thumbnail: "/videos/cap-free-screen-recorder-thumbnail.png",
		alt: "Cap free screen recorder demo showing high-quality features",
	},

	cta: {
		title: "Get Started with Cap – Your Free, High-Quality Screen Recorder",
		buttonText: "Download Cap Free",
	},
};

export const FreeScreenRecorderPage = () => {
	return <SeoPageTemplate content={freeScreenRecorderContent} />;
};
