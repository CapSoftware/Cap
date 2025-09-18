import React from "react";
import type { SeoPageContent } from "@/components/seo/types";
import type { FeaturePageConfig } from "./types";

export function transformFeaturePageToSeo(
	featurePageConfig: FeaturePageConfig,
	customIcons?: Record<string, JSX.Element>,
): SeoPageContent {
	const { content } = featurePageConfig;

	return {
		title: content.hero.title,
		description: `${content.hero.subtitle || ""}. ${content.hero.description}`,
		badge: "Feature",

		featuresTitle: content.features.title,
		featuresDescription: content.features.description,

		features: content.features.items.map((item) => ({
			title: item.title,
			description: item.description,
		})),

		recordingModes: content.comparison
			? {
					title: content.comparison.title,
					description: content.comparison.description,
					modes: content.comparison.modes.map((mode, index) => ({
						icon:
							customIcons?.[mode.name.toLowerCase().replace(/\s+/g, "-")] ||
							customIcons?.[`mode-${index}`] ||
							React.createElement("div", {
								className: "mb-4 size-8 rounded-full bg-blue-500",
							}),
						title: mode.name,
						description: `${mode.description}. ${mode.features.join(", ")}. Best for: ${mode.bestFor}`,
					})),
				}
			: undefined,

		useCasesTitle: content.useCases.title,
		useCasesDescription: content.useCases.description,

		useCases: content.useCases.cases.map((useCase) => ({
			title: useCase.title,
			description: `${useCase.description} Key benefits: ${useCase.benefits.join(", ")}.`,
		})),

		faqsTitle: content.faq.title,
		faqs: content.faq.items,

		video: content.video || {
			iframe: {
				src: "",
				title: "Feature Demo",
			},
		},

		cta: {
			title: content.cta.title,
			buttonText: content.cta.primaryButton,
			secondaryButtonText: content.cta.secondaryButton,
		},

		migrationGuide: content.workflow
			? {
					title: content.workflow.title,
					steps: content.workflow.steps.map(
						(step) => `${step.title}: ${step.description}`,
					),
				}
			: undefined,
	};
}

export function createFeaturePageStructuredData(
	featurePageConfig: FeaturePageConfig,
) {
	const { content } = featurePageConfig;

	return {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: content.faq.items.map((faq) => ({
			"@type": "Question",
			name: faq.question,
			acceptedAnswer: {
				"@type": "Answer",
				text: faq.answer.replace(/<\/?[^>]+(>|$)/g, ""),
			},
		})),
	};
}
