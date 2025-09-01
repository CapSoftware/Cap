export interface SeoPageContent {
	title: string;
	description: string;
	featuresTitle: string;
	featuresDescription: string;
	features: {
		title: string;
		description: string;
	}[];
	useCasesTitle: string;
	useCasesDescription: string;
	useCases: {
		title: string;
		description: string;
	}[];
	faqsTitle: string;
	faqs: {
		question: string;
		answer: string;
	}[];
	video: {
		url: string;
		thumbnail: string;
		alt?: string;
	};
	cta: {
		title: string;
		buttonText: string;
	};
	comparisonTitle?: string;
	comparisonDescription?: string;
	comparison?: {
		title: string;
		description: string;
	}[];
	comparisonTable?: {
		title: string;
		headers: string[];
		rows: string[][];
	};
	testimonials?: {
		title: string;
		items: {
			quote: string;
			author: string;
		}[];
	};
	migrationGuide?: {
		title: string;
		steps: string[];
	};
	recordingModes?: {
		title: string;
		description: string;
		modes: {
			title: string;
			description: string;
		}[];
	};
}
