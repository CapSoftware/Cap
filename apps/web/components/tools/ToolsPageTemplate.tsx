"use client";

import { Button } from "@cap/ui";
import Link from "next/link";
import { type ReactNode, useEffect } from "react";
import type { ToolPageContent } from "@/components/tools/types";

const renderHTML = (content: string) => {
	const styledContent = content.replace(
		/<a\s/g,
		'<a class="font-semibold text-blue-500 transition-colors hover:text-blue-600" ',
	);

	return <span dangerouslySetInnerHTML={{ __html: styledContent }} />;
};

const _LeftBlueHue = () => {
	return (
		<svg
			className="absolute top-0 -left-24 z-0 opacity-20 pointer-events-none md:opacity-40"
			width="1000"
			height="500"
			viewBox="0 0 1276 690"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<g filter="url(#blue-hue-filter)">
				<ellipse
					cx="592"
					cy="339"
					rx="584"
					ry="251"
					transform="rotate(180 592 339)"
					fill="url(#blue-hue-gradient)"
				/>
			</g>
			<defs>
				<filter
					id="blue-hue-filter"
					x="-92"
					y="-12"
					width="1368"
					height="702"
					filterUnits="userSpaceOnUse"
					colorInterpolationFilters="sRGB"
				>
					<feFlood floodOpacity="0" result="BackgroundImageFix" />
					<feBlend
						mode="normal"
						in="SourceGraphic"
						in2="BackgroundImageFix"
						result="shape"
					/>
					<feGaussianBlur stdDeviation="50" result="blur-effect" />
				</filter>
				<linearGradient
					id="blue-hue-gradient"
					x1="1102.5"
					y1="339"
					x2="157.5"
					y2="375.5"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#75A3FE" />
					<stop offset="1" stopColor="white" stopOpacity="0" />
				</linearGradient>
			</defs>
		</svg>
	);
};

export const ToolsPageTemplate = ({
	content,
	toolComponent,
}: {
	content: ToolPageContent;
	toolComponent: ReactNode;
}) => {
	useEffect(() => {
		const animateClouds = () => {
			const cloud4 = document.getElementById("cloud-4");
			const cloud5 = document.getElementById("cloud-5");

			if (cloud4 && cloud5) {
				cloud4.animate(
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

				cloud5.animate(
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
		<>
			{/* Compact Hero Section */}
			<div className="overflow-hidden relative py-32 md:py-40">
				{/* Breadcrumbs */}
				<div className="relative z-20 px-5 pt-4 text-center wrapper">
					<div className="flex justify-center items-center text-sm">
						<Link
							className="text-sm font-semibold text-gray-500 hover:underline"
							href="/tools"
						>
							Tools
						</Link>
						<span className="mx-2 text-sm text-gray-400">/</span>
						<span className="text-sm text-gray-500">{content.title}</span>
					</div>
				</div>

				<div className="relative z-10 px-5 pt-8 pb-6 w-full md:pt-12 md:pb-8">
					<div className="mx-auto max-w-3xl text-center wrapper wrapper-sm">
						<h1 className="fade-in-down text-[2rem] leading-[2.5rem] md:text-[2.75rem] md:leading-[3.25rem] relative z-10 text-black mb-4">
							{content.title}
						</h1>
						<p className="mx-auto mb-6 max-w-2xl text-md sm:text-lg text-zinc-600 fade-in-down animate-delay-1">
							{content.description}
						</p>
					</div>
				</div>
				<div className="relative z-10 py-10 wrapper">
					<div className="p-6 mx-auto max-w-4xl bg-white rounded-2xl border border-gray-100 shadow-lg md:p-8">
						{toolComponent}
					</div>
				</div>

				{/* Main Content - Features & FAQ */}
				<div className="relative z-10 py-16 wrapper">
					{/* Features Section */}
					<div className="mb-20">
						<div className="text-center max-w-[800px] mx-auto mb-12">
							<h2 className="inline-block relative mb-5 text-3xl font-medium text-gray-800">
								{content.featuresTitle}
								<span className="absolute -bottom-2 left-1/2 w-16 h-1 bg-blue-500 rounded-full transform -translate-x-1/2"></span>
							</h2>
							<p className="text-lg leading-relaxed text-gray-600">
								{renderHTML(content.featuresDescription)}
							</p>
						</div>
						<div className="grid grid-cols-1 gap-6 md:grid-cols-3">
							{content.features.map(
								(
									feature: { title: string; description: string },
									index: number,
								) => (
									<div
										key={index}
										className="p-6 bg-white rounded-xl border border-gray-100 shadow-sm transition-all duration-300 hover:shadow-md hover:border-blue-100"
									>
										<div className="flex justify-center items-center mb-4 w-10 h-10 bg-blue-50 rounded-full">
											<span className="text-lg font-medium text-blue-500">
												{index + 1}
											</span>
										</div>
										<h3 className="mb-3 text-lg font-semibold text-gray-800">
											{feature.title}
										</h3>
										<p className="text-sm leading-relaxed text-gray-600 md:text-base">
											{renderHTML(feature.description)}
										</p>
									</div>
								),
							)}
						</div>
					</div>

					{/* FAQ Section */}
					{content.faqs && (
						<div className="mb-20">
							<div className="text-center max-w-[800px] mx-auto mb-12">
								<h2 className="inline-block relative mb-5 text-3xl font-medium text-gray-800">
									Frequently Asked Questions
									<span className="absolute -bottom-2 left-1/2 w-16 h-1 bg-blue-500 rounded-full transform -translate-x-1/2"></span>
								</h2>
							</div>
							<div className="mx-auto mb-10 max-w-3xl">
								{content.faqs.map(
									(
										faq: { question: string; answer: string },
										index: number,
									) => (
										<div
											key={index}
											className="p-5 my-4 bg-white rounded-xl border border-gray-100 shadow-sm transition-all duration-300 hover:shadow-md"
										>
											<h2 className="mb-2 text-lg font-semibold text-gray-800">
												{faq.question}
											</h2>
											<div className="text-sm leading-relaxed text-gray-600 md:text-base">
												{renderHTML(faq.answer)}
											</div>
										</div>
									),
								)}
							</div>
						</div>
					)}

					{/* Clean CTA Section */}
					<div
						className="max-w-[900px] mx-auto rounded-2xl bg-white overflow-hidden relative flex flex-col justify-center p-8 md:p-10"
						style={{
							backgroundImage: "url('/illustrations/ctabg.svg')",
							backgroundSize: "cover",
							backgroundRepeat: "no-repeat",
						}}
					>
						<div className="flex relative z-10 flex-col justify-center items-center mx-auto h-full wrapper">
							<div className="text-center max-w-[700px] mx-auto mb-6">
								<h2 className="mb-3 text-2xl font-medium md:text-3xl text-gray-12">
									{content.cta.title}
								</h2>
								<p className="mb-5 text-lg text-gray-10">
									{content.cta.description}
								</p>
							</div>
							<div className="flex flex-col justify-center items-center space-y-3 sm:flex-row sm:space-y-0 sm:space-x-4">
								<Button
									variant="gray"
									href="/download"
									size="lg"
									className="px-8 w-full font-medium transition-all duration-200 sm:w-auto"
								>
									{content.cta.buttonText}
								</Button>
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Tool Container - Now positioned for visibility above the fold */}

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
		</>
	);
};
