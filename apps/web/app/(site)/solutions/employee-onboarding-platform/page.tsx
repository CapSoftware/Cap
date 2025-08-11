import { SeoPageTemplate } from "@/components/seo/SeoPageTemplate";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Employee Onboarding Platform: Streamline New-Hire Training with Cap",
  description:
    "Looking for a powerful employee onboarding platform? Discover how Cap's open-source screen recorder and asynchronous features simplify new-hire training.",
  openGraph: {
    title:
      "Employee Onboarding Platform: Streamline New-Hire Training with Cap",
    description:
      "Looking for a powerful employee onboarding platform? Discover how Cap's open-source screen recorder and asynchronous features simplify new-hire training.",
    url: "https://cap.so/solutions/employee-onboarding-platform",
    siteName: "Cap",
    images: [
      {
        url: "https://cap.so/og.png",
        width: 1200,
        height: 630,
        alt: "Cap: Employee Onboarding Platform",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Employee Onboarding Platform | Cap Screen Recorder",
    description:
      "Discover how Cap's open-source screen recorder simplifies new-hire training with asynchronous video and built-in feedback.",
    images: ["https://cap.so/og.png"],
  },
};

import Script from "next/script";

const content = {
  title: "Employee Onboarding Platform: Streamline New-Hire Training with Cap",
  description:
    "Looking for a powerful employee onboarding platform? Discover how Cap's open-source screen recorder and asynchronous features simplify new-hire training.",

  featuresTitle: "Why Cap is the Ideal Employee Onboarding Platform",
  featuresDescription:
    "Cap provides everything HR and People Ops teams need to create an efficient, engaging onboarding experience",

  features: [
    {
      title: "Async Video Training",
      description:
        "Eliminate repetitive live sessions by creating reusable training videos that new hires can watch on their own schedule. Record once, use for multiple onboarding cycles.",
    },
    {
      title: "Built-in Feedback System",
      description:
        "Thread comments let new hires ask questions directly on each training video, ensuring they get the answers they need without scheduling additional meetings.",
    },
    {
      title: "Security & Privacy",
      description:
        "Ensure sensitive HR content and company information remains secure with Cap's open-source approach and custom S3 storage options for complete data ownership.",
    },
    {
      title: "Time-Saving Onboarding",
      description:
        "HR teams save hours each week by replacing repetitive live training sessions with comprehensive screen recordings that new employees can reference anytime.",
    },
    {
      title: "Cost-Effective Solution",
      description:
        "Cap offers a powerful onboarding tool at a fraction of the cost of specialized HR platforms, with a free tier that's perfect for smaller organizations.",
    },
    {
      title: "Cross-Platform Accessibility",
      description:
        "Works seamlessly on both Mac and Windows, ensuring all new hires have access to the same quality onboarding materials regardless of their device preferences.",
    },
  ],

  recordingModes: {
    title: "Two Recording Modes for Different Onboarding Needs",
    description:
      "Cap adapts to your organization's onboarding requirements with flexible recording options",
    modes: [
      {
        title: "Instant Mode for Quick Walkthroughs",
        description:
          "Perfect for brief system introductions and quick process demonstrations. Record and share in seconds with a simple link that new hires can instantly access with built-in commenting for questions.",
      },
      {
        title: "Studio Mode for Comprehensive Training",
        description:
          "Ideal for detailed company overviews and complex system training. Create professional-quality onboarding videos with separate screen and webcam capture for engaging, thorough new-hire education.",
      },
    ],
  },

  useCasesTitle: "How HR Teams Use Cap for Onboarding",
  useCasesDescription:
    "Real solutions for common employee onboarding challenges",

  useCases: [
    {
      title: "Create a Knowledge Library",
      description:
        "Build a comprehensive library of recorded training sessions that can be reused for future hires, ensuring consistent onboarding quality while reducing redundant live sessions.",
    },
    {
      title: "System & Tool Training",
      description:
        "Record detailed walkthroughs of company software, tools, and internal systems, complete with visual demonstrations that text-based documentation can't provide.",
    },
    {
      title: "Remote & Hybrid Onboarding",
      description:
        "Deliver the same high-quality onboarding experience to all new hires regardless of location, eliminating the quality gap between in-office and remote employee training.",
    },
    {
      title: "Self-Paced Learning",
      description:
        "Allow new hires to learn at their own pace, rewatching complex sections as needed and marking training videos as complete when they're ready to move forward.",
    },
  ],

  faqsTitle: "Employee Onboarding Platform FAQs",
  faqs: [
    {
      question: "Is Cap secure enough for confidential HR data?",
      answer:
        "Yes, Cap prioritizes security with its open-source approach that provides complete transparency about data handling. You can connect your own S3 storage and custom domain for complete data ownership, ensuring sensitive HR information and company procedures remain under your control.",
    },
    {
      question: "How do we organize multiple training sessions for new hires?",
      answer:
        "Cap makes organizing training content simple with customizable folders and collections. HR teams can create dedicated onboarding libraries with categorized videos for different departments or roles, making it easy for new hires to find the right training materials when they need them.",
    },
    {
      question: "Can new hires comment in real-time on training videos?",
      answer:
        "Yes, Cap's built-in threaded comment system allows new employees to ask questions or provide feedback directly on specific timestamps of training videos. HR teams and managers receive notifications and can respond asynchronously, creating a seamless Q&A experience without scheduling additional meetings.",
    },
    {
      question:
        "Does Cap integrate with Slack or Teams for onboarding updates?",
      answer:
        "Cap provides easy-to-share links that work seamlessly with all major communication platforms including Slack, Microsoft Teams, and HR tools. Simply copy the link to your onboarding video and paste it into your company's preferred communication channels for immediate access.",
    },
    {
      question: "How can Cap reduce our onboarding time and costs?",
      answer:
        "Cap typically reduces onboarding time by 40-60% by eliminating repetitive live training sessions and creating reusable video resources. HR teams save 5-10 hours per new hire, while also improving training consistency and reducing the time managers spend answering the same questions repeatedly.",
    },
  ],

  comparisonTable: {
    title: "Cap vs. Traditional Employee Onboarding Platforms",
    headers: [
      "Feature",
      "Cap",
      "Traditional HR Platforms",
      "Basic Screen Recorders",
    ],
    rows: [
      [
        "Upfront Cost",
        "✅ Free tier available",
        "❌ High monthly subscriptions",
        "⚠️ Mixed (free to premium)",
      ],
      [
        "Data Ownership",
        "✅ Complete with S3 integration",
        "⚠️ Vendor controlled",
        "❌ Often stored on third-party servers",
      ],
      [
        "Onboarding Feedback",
        "✅ Built-in threaded comments",
        "✅ Sophisticated systems",
        "❌ Typically requires separate tools",
      ],
      [
        "Video Quality",
        "✅ High-resolution (up to 4K)",
        "❌ Limited or no video capability",
        "⚠️ Variable quality",
      ],
      [
        "Implementation Time",
        "✅ Minutes to set up",
        "❌ Weeks of configuration",
        "✅ Quick setup",
      ],
      [
        "Privacy & Security",
        "✅ Open-source transparency",
        "⚠️ Varies by provider",
        "❌ Often limited",
      ],
      [
        "Specialized HR Features",
        "⚠️ Focused on visual training",
        "✅ Comprehensive HR tools",
        "❌ None",
      ],
    ],
  },

  migrationGuide: {
    title: "How to Implement Cap for Employee Onboarding",
    steps: [
      "Download Cap for your HR team (available on Mac and Windows)",
      "Set up shared S3 storage (optional) for secure onboarding content",
      "Create an onboarding content structure with key training categories",
      "Record essential system walkthroughs and company introductions",
      "Share links to training content in your existing onboarding documentation",
      "Train HR team members to respond to new hire questions via comments",
    ],
  },

  video: {
    url: "/videos/employee-onboarding-demo.mp4",
    thumbnail: "/videos/employee-onboarding-thumbnail.png",
    alt: "Cap screen recorder demonstration for employee onboarding",
  },

  cta: {
    title: "Ready to Transform Your Employee Onboarding Experience?",
    buttonText: "Download Cap Free",
  },
};

// Create FAQ structured data for SEO
const createFaqStructuredData = () => {
  const faqStructuredData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: content.faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer.replace(/<\/?[^>]+(>|$)/g, ""),
      },
    })),
  };

  return JSON.stringify(faqStructuredData);
};

export default function Page() {
  return (
    <>
      <Script
        id="faq-structured-data"
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: createFaqStructuredData() }}
      />
      <SeoPageTemplate content={content} />
    </>
  );
}
