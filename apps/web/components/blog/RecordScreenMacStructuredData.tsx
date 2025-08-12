"use client";

import Script from "next/script";
import { recordScreenMacContent } from "../../content/blog-content/record-screen-mac-system-audio";

// Create Article structured data for SEO
const createArticleStructuredData = () => {
	const articleStructuredData = {
		"@context": "https://schema.org",
		"@type": "BlogPosting",
		headline: recordScreenMacContent.title,
		description: recordScreenMacContent.description,
		author: {
			"@type": "Person",
			name: recordScreenMacContent.author,
		},
		datePublished: recordScreenMacContent.publishedAt,
		image: recordScreenMacContent.videoDemo?.videoSrc,
		keywords: recordScreenMacContent.tags.join(","),
		mainEntityOfPage: {
			"@type": "WebPage",
			"@id": "https://cap.so/blog/record-screen-mac-system-audio",
		},
	};

	return JSON.stringify(articleStructuredData);
};

// Create FAQ structured data for SEO
const createFaqStructuredData = () => {
	const faqStructuredData = {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: recordScreenMacContent.faqs.map((faq) => ({
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

export const RecordScreenMacStructuredData = () => {
	return (
		<>
			<Script
				id="article-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: createArticleStructuredData() }}
			/>
			<Script
				id="faq-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: createFaqStructuredData() }}
			/>
		</>
	);
};
