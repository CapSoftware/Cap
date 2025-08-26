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
}
