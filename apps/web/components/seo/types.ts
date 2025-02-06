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
  };
  cta: {
    title: string;
    buttonText: string;
  };
}
