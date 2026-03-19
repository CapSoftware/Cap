export interface FeaturePageHero {
	title: string;
	subtitle?: string;
	description: string;
	primaryCta: string;
	secondaryCta?: string;
	features?: string[];
}

export interface FeaturePageFeature {
	title: string;
	description: string;
	icon?: string;
}

export interface FeaturePageUseCase {
	title: string;
	description: string;
	benefits: string[];
}

export interface FeaturePageMode {
	name: string;
	description: string;
	features: string[];
	bestFor: string;
	isPrimary?: boolean;
}

export interface FeaturePageComparison {
	title: string;
	description: string;
	modes: FeaturePageMode[];
}

export interface FeaturePageWorkflowStep {
	title: string;
	description: string;
	icon?: string;
}

export interface FeaturePageWorkflow {
	title: string;
	description: string;
	steps: FeaturePageWorkflowStep[];
}

export interface FeaturePageFaq {
	question: string;
	answer: string;
}

export interface FeaturePageVideo {
	title?: string;
	iframe?: {
		src: string;
		title?: string;
	};
	mux?: {
		playbackId: string;
		title?: string;
	};
}

export interface FeaturePageCta {
	title: string;
	description?: string;
	primaryButton: string;
	secondaryButton?: string;
}

export interface FeaturePageContent {
	hero: FeaturePageHero;
	features: {
		title: string;
		description: string;
		items: FeaturePageFeature[];
	};
	useCases: {
		title: string;
		description: string;
		cases: FeaturePageUseCase[];
	};
	comparison?: FeaturePageComparison;
	workflow?: FeaturePageWorkflow;
	faq: {
		title: string;
		items: FeaturePageFaq[];
	};
	video?: FeaturePageVideo;
	cta: FeaturePageCta;
}

export interface FeaturePageConfig {
	slug: string;
	content: FeaturePageContent;
	seo?: {
		metaTitle?: string;
		metaDescription?: string;
		ogImage?: string;
	};
	customSections?: {
		showVideo?: boolean;
		showComparison?: boolean;
		showWorkflow?: boolean;
	};
}
