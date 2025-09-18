export type ComparisonStatus = "positive" | "negative" | "warning" | "neutral";
export interface ComparisonCell {
	text: string;
	status?: ComparisonStatus;
}

export interface SeoPageContent {
	title: string;
	description: string;
	badge?: string;
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
		title?: string;
		url?: string;
		thumbnail?: string;
		alt?: string;
		iframe?: {
			src: string;
			title?: string;
		};
	};
	cta: {
		title: string;
		buttonText: string;
		secondaryButtonText?: string;
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
		rows: (string | ComparisonCell)[][];
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
			icon: JSX.Element;
			title: string;
			description: string;
		}[];
	};
}
