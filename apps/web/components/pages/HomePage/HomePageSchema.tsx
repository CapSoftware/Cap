"use client";

import Script from "next/script";
import { testimonials } from "@/data/testimonials";
import {
	createBreadcrumbSchema,
	createFAQSchema,
	createOrganizationSchema,
	createProductSchema,
	createSoftwareApplicationSchema,
	createWebSiteSchema,
} from "@/utils/web-schema";

const homePageFAQs = [
	{
		question: "What is Cap?",
		answer:
			"Cap is an open-source screen recording software that offers beautiful, lightweight recordings with instant sharing capabilities. It's the privacy-focused alternative to Loom.",
	},
	{
		question: "How much does Cap cost?",
		answer:
			"Cap offers a generous free plan with Studio mode for personal use and 5-minute shareable links. The Pro plan starts at just $8.16/month per user, which is less than half the price of Loom.",
	},
	{
		question: "Is Cap available for Windows and Mac?",
		answer:
			"Yes, Cap is available for both macOS and Windows, providing consistent performance and features across both platforms.",
	},
	{
		question: "Can I use my own storage with Cap?",
		answer:
			"Yes, Cap allows you to connect your own S3 storage and custom domain, giving you 100% ownership and control over your content.",
	},
	{
		question: "What makes Cap different from other screen recorders?",
		answer:
			"Cap is fully open-source, privacy-focused, and offers unique features like Studio mode (free for personal use), 4K recording at 60fps, built-in thread commenting, and the ability to use your own storage and domain.",
	},
	{
		question: "Does Cap support team collaboration?",
		answer:
			"Yes, Cap includes built-in thread commenting on shareable links, making it easy to collaborate with teammates and collect feedback directly on your recordings.",
	},
];

const createHomePageSchema = () => {
	const schemas = [
		createOrganizationSchema(),
		createWebSiteSchema(),
		createSoftwareApplicationSchema(testimonials),
		createProductSchema(),
		createBreadcrumbSchema([{ name: "Home", url: "https://cap.so" }]),
		createFAQSchema(homePageFAQs),
	];

	return JSON.stringify(schemas);
};

export const HomePageSchema = () => {
	return (
		<Script
			id="homepage-structured-data"
			type="application/ld+json"
			dangerouslySetInnerHTML={{ __html: createHomePageSchema() }}
		/>
	);
};
