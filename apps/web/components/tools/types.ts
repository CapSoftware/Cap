export interface ToolPageContent {
	slug?: string;
	title: string;
	description: string;
	publishedAt?: string;
	category?: string;
	author?: string;
	tags?: string[];

	cta: {
		title: string;
		description: string;
		buttonText: string;
		buttonHref?: string;
		secondaryButtonText?: string;
		secondaryButtonHref?: string;
	};

	featuresTitle: string;
	featuresDescription: string;
	features: Array<{
		title: string;
		description: string;
	}>;

	faqs?: Array<{
		question: string;
		answer: string;
	}>;

	/**
	 * Optional HowTo steps. Emitted as HowTo structured data by
	 * `ToolsPageTemplate`, which makes the page eligible for step-by-step rich
	 * results on "how do I ..." queries.
	 */
	howTo?: {
		name: string;
		description: string;
		totalTime?: string;
		steps: Array<{ name: string; text: string }>;
	};
}
