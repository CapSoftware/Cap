export interface ToolPageContent {
  title: string;
  description: string;
  featuresTitle: string;
  featuresDescription: string;
  features: {
    title: string;
    description: string;
  }[];
  faqs?: {
    question: string;
    answer: string;
  }[];
  cta: {
    title: string;
    description: string;
    buttonText: string;
  };
} 