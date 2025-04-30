export interface ToolPageContent {
  title: string;
  description: string;
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
