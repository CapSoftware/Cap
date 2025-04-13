"use client";

import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import Script from "next/script";

export const loomAlternativeContent = {
  title:
    "The Ultimate Loom Alternative: Why Cap is the Best Open-Source Screen Recorder for Mac & Windows",
  description:
    "Looking for the best Loom alternative? Discover Cap, the open-source, privacy-focused screen recorder for Mac & Windows. See why users are switching today!",

  featuresTitle: "Why Cap is the Best Loom Alternative",
  featuresDescription:
    "Cap offers everything you need in a privacy-focused, open-source screen recording solution",

  features: [
    {
      title: "Open-Source Transparency",
      description:
        "Cap is fully open-source, giving you complete transparency and community-driven development. We believe in building in public and letting users help shape our roadmap. Looking for an <a href='/free-screen-recorder'>open-source screen recorder</a>? Cap is your best choice!",
    },
    {
      title: "Enhanced Privacy & Security",
      description:
        "Cap prioritizes your privacy with GDPR compliance and the option to use your own S3 storage, ensuring your data remains under your control. Connect your own custom domain for a branded experience while maintaining 100% ownership of your data.",
    },
    {
      title: "Half the Price of Loom",
      description:
        "Cap is just $9/month per user, compared to Loom's $18/month per user. Plus, Cap offers a generous free plan that includes Studio mode for personal use.",
    },
    {
      title: "High-Quality Recordings",
      description:
        "Record smooth, high-definition videos at 60fps with synchronized audio up to 4K resolution, perfect for professional use.",
    },
    {
      title: "Collaborative Features",
      description:
        "Cap includes built-in thread commenting on shareable links, making it easy to collaborate with teammates and collect feedback on your recordings without switching platforms.",
    },
    {
      title: "Cross-Platform Support",
      description:
        "Available for both Mac and Windows, Cap delivers consistent performance across platforms. A perfect <a href='/screen-recording-software'>screen recording software</a> for all users.",
    },
  ],

  recordingModes: {
    title: "Two Ways to Record with Cap",
    description:
      "Cap gives you flexible recording options to match your workflow needs, with both modes available in the free plan",
    modes: [
      {
        title: "Instant Mode",
        description:
          "Share your screen right away with a simple link—no waiting, just record and share in seconds. Record up to 5-minute shareable links for free, perfect for quick demos and explanations. Includes built-in thread commenting for easy collaboration.",
      },
      {
        title: "Studio Mode",
        description:
          "Available completely free for personal use! Records at top quality up to 4K. Captures both your screen and webcam separately so you can edit them later, giving you professional-level production control.",
      },
    ],
  },

  useCasesTitle: "Why Users Choose Cap for Screen Recording",
  useCasesDescription:
    "Discover the features that make Cap a compelling option for screen recording",

  useCases: [
    {
      title: "Budget-Friendly Options",
      description:
        "Many screen recording tools have complex pricing structures. Cap offers similar functionality with clear, affordable pricing options.",
    },
    {
      title: "Complete Data Ownership",
      description:
        "Cap lets you connect your own S3 storage and custom domain, giving you 100% ownership and control over your content. No more being locked into proprietary platforms.",
    },
    {
      title: "Community-Driven Development",
      description:
        "As an <a href='/screen-recorder'>open-source screen recorder</a>, Cap is built in the open with community input. User feedback directly shapes our roadmap and features.",
    },
    {
      title: "Collaborative Feedback",
      description:
        "Cap's built-in thread commenting on shareable links makes it easy to collect feedback and collaborate without switching between different tools.",
    },
  ],

  faqsTitle: "Frequently Asked Questions",
  faqs: [
    {
      question: "Is there a free Loom alternative?",
      answer:
        "Yes, Cap offers a generous free tier that includes all essential screen recording features. You can use Studio mode completely free for personal use, record up to 5-minute shareable links, and record in up to 4K resolution. Cap's free plan offers more than Loom's free tier.",
    },
    {
      question: "Why choose an open-source screen recorder?",
      answer:
        "Open-source screen recorders like Cap provide transparency, security, and community-driven development. You can verify the code, contribute improvements, and trust that your data isn't being misused. Cap's community focus means features are developed based on real user needs.",
    },
    {
      question: "How does Cap compare in pricing with Loom?",
      answer:
        "Cap is significantly more affordable at just $9/month per user, compared to Loom's $18/month per user. Cap also has a more generous free plan that includes Studio mode for personal use and the ability to record shareable links up to 5 minutes in 4K quality.",
    },
    {
      question: "Can I keep full ownership of my recordings with Cap?",
      answer:
        "Absolutely! Cap allows you to connect your own S3 storage and custom domain, giving you 100% ownership and control of your content. Your data remains yours, and you're never locked into our platform.",
    },
    {
      question: "Does Cap support collaboration features?",
      answer:
        "Yes, Cap includes built-in thread commenting on shareable links, making it easy to collaborate with teammates and collect feedback directly on your recordings. This keeps all your communication in one place.",
    },
  ],

  comparisonTable: {
    title: "Feature Comparison: Cap vs. Loom",
    headers: ["Feature", "Cap", "Loom"],
    rows: [
      ["Open Source", "✅ Yes", "❌ No"],
      ["Pricing", "✅ $9/month per user", "⚠️ $18/month per user"],
      [
        "Free Plan",
        "✅ Studio mode + 5 min shareable links",
        "⚠️ Limited features & recording time",
      ],
      [
        "4K Recording",
        "✅ Available in free & paid plans",
        "⚠️ Only in paid plans",
      ],
      ["Thread Commenting", "✅ Built-in on shareable links", "☑️ Available"],
      ["Custom Domain", "✅ Yes", "☑️ Enterprise plan only"],
      ["Own Storage Integration", "✅ Connect your own S3", "❌ Not available"],
      ["Community Input", "✅ Direct via open source", "☑️ Limited"],
      ["Data Ownership", "✅ 100% with own storage", "☑️ Platform dependent"],
    ],
  },
  migrationGuide: {
    title: "How to Get Started with Cap (Easy Guide)",
    steps: [
      "Download Cap for your operating system (Mac or Windows)",
      "Launch the application",
      "Start recording using either Instant Mode or Studio Mode",
      "Share your recordings easily with Cap's built-in sharing features",
      "Optional: Connect your own S3 storage and custom domain for complete data ownership",
    ],
  },

  video: {
    url: "/videos/cap-vs-loom-comparison.mp4",
    thumbnail: "/videos/cap-vs-loom-thumbnail.png",
    alt: "Cap screen recorder demo showing privacy features and interface",
  },

  cta: {
    title: "Ready to Try Cap for Your Screen Recording Needs?",
    buttonText: "Download Cap Free",
  },
};

// Create FAQ structured data for SEO
const createFaqStructuredData = () => {
  const faqStructuredData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: loomAlternativeContent.faqs.map((faq) => ({
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

export const LoomAlternativePage = () => {
  return (
    <>
      <Script
        id="faq-structured-data"
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: createFaqStructuredData() }}
      />
      <SeoPageTemplate content={loomAlternativeContent} />
    </>
  );
};
