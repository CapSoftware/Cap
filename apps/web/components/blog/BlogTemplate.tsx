"use client";

import { Button } from "@cap/ui";
import MuxPlayer from "@mux/mux-player-react";
import Link from "next/link";
import { useEffect } from "react";
import { formatDate } from "../../lib/utils";

interface BlogPost {
	title: string;
	description: string;
	publishedAt: string;
	category: string;
	image?: string;
	author: string;
	tags: string[];
	heroTLDR: string;
	comparisonTable?: {
		title: string;
		headers: string[];
		rows: string[][];
	};
	methods?: {
		title: string;
		description: string;
		steps: {
			title?: string;
			content: string;
		}[];
	}[];
	troubleshooting?: {
		title: string;
		items: {
			question: string;
			answer: string;
		}[];
	};
	proTips?: {
		title: string;
		tips: {
			title: string;
			description: string;
		}[];
	};
	videoDemo?: {
		title: string;
		videoSrc: string;
		caption: string;
	};
	faqs?: {
		question: string;
		answer: string;
	}[];
	testimonial?: {
		quote: string;
		author: string;
		avatar: string;
	};
	cta: {
		title: string;
		description: string;
		buttonText: string;
		buttonLink: string;
		subtitle: string;
	};
	relatedLinks?: {
		text: string;
		url: string;
	}[];
}

const renderHTML = (content: string) => {
	const styledContent = content.replace(
		/<a\s/g,
		'<a class="font-semibold text-blue-500 transition-colors hover:text-blue-600" ',
	);

	return <div dangerouslySetInnerHTML={{ __html: styledContent }} />;
};

export const BlogTemplate = ({ content }: { content: BlogPost }) => {
	useEffect(() => {
		const animateClouds = () => {
			const cloud1 = document.getElementById("blog-cloud-1");
			const cloud2 = document.getElementById("blog-cloud-2");

			if (cloud1 && cloud2) {
				cloud1.animate(
					[
						{ transform: "translateX(0) translateY(0)" },
						{ transform: "translateX(-10px) translateY(5px)" },
						{ transform: "translateX(10px) translateY(-5px)" },
						{ transform: "translateX(0) translateY(0)" },
					],
					{
						duration: 15000,
						iterations: Infinity,
						easing: "ease-in-out",
					},
				);

				cloud2.animate(
					[
						{ transform: "translateX(0) translateY(0)" },
						{ transform: "translateX(10px) translateY(-5px)" },
						{ transform: "translateX(-10px) translateY(5px)" },
						{ transform: "translateX(0) translateY(0)" },
					],
					{
						duration: 18000,
						iterations: Infinity,
						easing: "ease-in-out",
					},
				);
			}
		};

		animateClouds();
	}, []);

	return (
		<article className="relative z-10 px-3 py-32 mx-auto max-w-3xl md:py-40">
			{/* Header */}
			<header className="mb-16 text-center">
				<div className="mb-4 text-sm font-medium text-blue-600 fade-in-down">
					{content.category}
				</div>
				<h1 className="mb-6 text-4xl font-medium text-gray-900 md:text-5xl fade-in-down">
					{content.title}
				</h1>
				<p className="mx-auto mb-8 max-w-3xl text-xl text-gray-700 md:text-2xl fade-in-down animate-delay-1">
					{content.description}
				</p>
				<div className="flex justify-center items-center space-x-2 text-sm text-gray-10 fade-in-down animate-delay-2">
					<time dateTime={content.publishedAt}>
						{formatDate(content.publishedAt)}
					</time>
					<span>•</span>
					<span>by {content.author}</span>
				</div>
			</header>

			{/* Featured Image */}
			{content.image && (
				<div className="overflow-hidden mb-12 rounded-xl shadow-xl transition-all duration-300 transform hover:-translate-y-1">
					<img
						src={content.image}
						alt={content.title}
						className="object-cover w-full h-auto"
					/>
				</div>
			)}

			{/* Hero TL;DR */}
			<div className="p-8 mb-12 bg-blue-50 rounded-xl border border-blue-100 shadow-md transition-all duration-300 transform hover:shadow-xl hover:-translate-y-1">
				<h2 className="inline-block relative mb-4 text-2xl font-medium text-gray-900">
					TL;DR
					<span className="absolute left-0 -bottom-1 w-16 h-1 bg-blue-500 rounded-full"></span>
				</h2>
				<p className="mt-6 text-xl text-gray-700">{content.heroTLDR}</p>
				<div className="inline-flex mt-6">
					<Button
						href={content.cta.buttonLink}
						size="lg"
						variant="blue"
						className="px-6 py-3 shadow-lg transition-all duration-300 transform hover:shadow-xl hover:-translate-y-1"
					>
						{content.cta.buttonText}
					</Button>
				</div>
			</div>

			{/* Comparison Table */}
			{content.comparisonTable && (
				<section className="mb-16">
					<h2 className="inline-block relative mb-8 text-3xl font-medium text-gray-900">
						{content.comparisonTable.title}
						<span className="absolute -bottom-2 left-1/2 w-20 h-1 bg-blue-500 rounded-full transform -translate-x-1/2"></span>
					</h2>

					<div className="overflow-x-auto">
						<table className="overflow-hidden w-full rounded-lg shadow-md border-collapse transition-all duration-300 hover:shadow-lg">
							<thead className="bg-blue-50">
								<tr>
									{content.comparisonTable.headers.map((header, index) => (
										<th
											key={index}
											className="px-6 py-4 font-semibold text-left text-gray-700 border-b border-gray-200"
										>
											{header}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{content.comparisonTable.rows.map((row, rowIndex) => (
									<tr
										key={rowIndex}
										className={rowIndex % 2 === 0 ? "bg-gray-1" : "bg-gray-50"}
									>
										{row.map((cell, cellIndex) => (
											<td
												key={cellIndex}
												className="px-6 py-4 border-b border-gray-200"
												dangerouslySetInnerHTML={{ __html: cell }}
											/>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			)}

			{/* Methods */}
			{content.methods &&
				content.methods.map((method, index) => (
					<section key={index} className="mb-16">
						<h2 className="inline-block relative mb-6 text-3xl font-medium text-gray-900">
							{method.title}
							<span className="absolute -bottom-2 left-1/2 w-20 h-1 bg-blue-500 rounded-full transform -translate-x-1/2"></span>
						</h2>
						<p className="mb-8 text-xl text-gray-700">{method.description}</p>

						{method.steps.map((step, stepIndex) => (
							<div
								key={stepIndex}
								className="p-6 mb-8 rounded-xl border border-gray-100 shadow-md transition-all duration-300 transform bg-gray-1 hover:shadow-xl hover:border-blue-100 hover:-translate-y-1"
							>
								{step.title && (
									<h3 className="mb-4 text-2xl font-semibold text-gray-800">
										{step.title}
									</h3>
								)}
								<div className="max-w-none prose prose-lg">
									{renderHTML(step.content)}
								</div>
							</div>
						))}
					</section>
				))}

			{/* Troubleshooting */}
			{content.troubleshooting && (
				<section className="mb-16">
					<h2 className="inline-block relative mb-8 text-3xl font-medium text-gray-900">
						{content.troubleshooting.title}
						<span className="absolute -bottom-2 left-1/2 w-20 h-1 bg-blue-500 rounded-full transform -translate-x-1/2"></span>
					</h2>

					<div className="space-y-4">
						{content.troubleshooting.items.map((item, index) => (
							<details
								key={index}
								className="p-6 rounded-xl border border-gray-100 shadow-md transition-all duration-300 bg-gray-1 hover:shadow-xl hover:border-blue-100"
							>
								<summary className="text-xl font-semibold text-gray-800 cursor-pointer">
									{item.question}
								</summary>
								<p className="mt-4 text-gray-700">{item.answer}</p>
							</details>
						))}
					</div>
				</section>
			)}

			{/* Pro Tips */}
			{content.proTips && (
				<section className="mb-16">
					<h2 className="inline-block relative mb-8 text-3xl font-medium text-gray-900">
						{content.proTips.title}
						<span className="absolute -bottom-2 left-1/2 w-20 h-1 bg-blue-500 rounded-full transform -translate-x-1/2"></span>
					</h2>

					<div className="grid grid-cols-1 gap-6 md:grid-cols-3">
						{content.proTips.tips.map((tip, index) => (
							<div
								key={index}
								className="p-6 bg-blue-50 rounded-xl border border-blue-100 shadow-md transition-all duration-300 transform hover:shadow-xl hover:-translate-y-1"
							>
								<h3 className="mb-3 text-xl font-semibold text-blue-800">
									🔹 {tip.title}
								</h3>
								<p className="text-gray-700">{tip.description}</p>
							</div>
						))}
					</div>
				</section>
			)}

			{/* Video Demo */}
			{content.videoDemo && (
				<section className="mb-16">
					<h2 className="inline-block relative mb-6 text-3xl font-medium text-gray-900">
						{content.videoDemo.title}
						<span className="absolute -bottom-2 left-1/2 w-20 h-1 bg-blue-500 rounded-full transform -translate-x-1/2"></span>
					</h2>

					<figure className="overflow-hidden rounded-xl shadow-lg transition-all duration-300 transform hover:shadow-xl hover:-translate-y-1">
						<MuxPlayer
							playbackId="A6oZoUWVZjOIVZB6XnBMLagYnXE6xhDhp8Hcyky018hk"
							metadataVideoTitle="Cap Demo"
							accentColor="#5C9FFF"
							style={{ aspectRatio: "16/9", width: "100%" }}
						/>
					</figure>
				</section>
			)}

			{/* FAQs */}
			{content.faqs && (
				<section className="mb-16">
					<h2 className="inline-block relative mb-8 text-3xl font-medium text-gray-900">
						Frequently Asked Questions
						<span className="absolute -bottom-2 left-1/2 w-20 h-1 bg-blue-500 rounded-full transform -translate-x-1/2"></span>
					</h2>

					<div className="space-y-4">
						{content.faqs.map((faq, index) => (
							<details
								key={index}
								className="p-6 rounded-xl border border-gray-100 shadow-md transition-all duration-300 bg-gray-1 hover:shadow-xl hover:border-blue-100"
							>
								<summary className="text-xl font-semibold text-gray-800 cursor-pointer">
									{faq.question}
								</summary>
								<p className="mt-4 text-gray-700">{faq.answer}</p>
							</details>
						))}
					</div>
				</section>
			)}

			{/* Testimonial */}
			{content.testimonial && (
				<section className="mb-16">
					<h2 className="inline-block relative mb-8 text-3xl font-medium text-gray-900">
						What Users Are Saying
						<span className="absolute -bottom-2 left-1/2 w-20 h-1 bg-blue-500 rounded-full transform -translate-x-1/2"></span>
					</h2>

					<blockquote className="p-8 rounded-xl border-l-4 border-blue-500 shadow-md transition-all duration-300 transform bg-gray-1 hover:shadow-xl hover:-translate-y-1">
						<p className="mb-6 text-xl italic text-gray-700">
							"{content.testimonial.quote}"
						</p>
						<footer className="flex items-center">
							<img
								src={content.testimonial.avatar}
								alt={content.testimonial.author}
								className="mr-4 w-12 h-12 rounded-full"
							/>
							<cite className="not-italic font-medium text-gray-900">
								{content.testimonial.author}
							</cite>
						</footer>
					</blockquote>
				</section>
			)}

			{/* CTA Section */}
			<section className="mb-16">
				<div
					className="overflow-hidden relative p-10 rounded-2xl shadow-lg"
					style={{
						background:
							"linear-gradient(135deg, #4f46e5 0%, #3b82f6 50%, #0ea5e9 100%)",
					}}
				>
					<div
						id="blog-cloud-1"
						className="absolute top-0 -right-20 z-0 opacity-30 transition-transform duration-700 ease-in-out pointer-events-none"
					>
						<img
							className="max-w-[40vw] h-auto"
							src="/illustrations/cloud-1.png"
							alt="CTA Cloud One"
						/>
					</div>
					<div
						id="blog-cloud-2"
						className="absolute bottom-0 left-0 z-0 opacity-30 transition-transform duration-700 ease-in-out pointer-events-none"
					>
						<img
							className="max-w-[40vw] h-auto"
							src="/illustrations/cloud-2.png"
							alt="CTA Cloud Two"
						/>
					</div>
					<div className="relative z-10">
						<h2 className="mb-4 text-3xl font-medium text-white">
							{content.cta.title}
						</h2>
						<p className="mb-8 text-xl text-white/90">
							{content.cta.description}
						</p>
						<div className="inline-flex">
							<Button
								href={content.cta.buttonLink}
								variant="white"
								size="lg"
								className="px-8 py-3 text-blue-600 shadow-lg transition-all duration-300 transform hover:shadow-xl hover:-translate-y-1"
							>
								{content.cta.buttonText}
							</Button>
						</div>
					</div>
				</div>
			</section>

			{/* Related Links */}
			{content.relatedLinks && content.relatedLinks.length > 0 && (
				<div className="italic text-center text-gray-600">
					Check out {(() => {
						const links = content.relatedLinks;
						return links.map((link, index) => (
							<span key={index}>
								<Link
									href={link.url}
									className="text-blue-600 transition-colors hover:underline"
								>
									{link.text}
								</Link>
								{index < links.length - 1 ? " or " : ""}
							</span>
						));
					})()}.
				</div>
			)}

			<style jsx global>{`
        @keyframes fade-in-down {
          0% {
            opacity: 0;
            transform: translateY(-10px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes fade-in-up {
          0% {
            opacity: 0;
            transform: translateY(10px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .fade-in-down {
          animation: fade-in-down 0.8s ease-out forwards;
        }

        .fade-in-up {
          animation: fade-in-up 0.8s ease-out forwards;
        }

        .animate-delay-1 {
          animation-delay: 0.1s;
        }

        .animate-delay-2 {
          animation-delay: 0.2s;
        }
      `}</style>
		</article>
	);
};
