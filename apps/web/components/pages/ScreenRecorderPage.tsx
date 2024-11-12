"use client";

import { SeoPageTemplate } from "../seo/SeoPageTemplate";

export const screenRecorderContent = {
  title: "Screen Recorder: High-Quality, User-Friendly, and 100% Free Locally",
  description:
    "Cap is a powerful, user-friendly screen recorder and is 100% free locally with no usage limits. Perfect for team collaboration, creating tutorials, or recording professional presentations with ease and precision.",

  featuresTitle: "Key Features",
  featuresDescription:
    "Create stunning screen recordings with powerful collaboration features.",

  features: [
    {
      title: "Easy to Use",
      description:
        "Start recording with just a few clicks. No complex setup needed.",
    },
    {
      title: "High-Quality Recording",
      description:
        "Capture crystal-clear footage with smooth frame rates and synchronized audio.",
    },
    {
      title: "Completely Free",
      description:
        "Enjoy professional-grade screen recording without any cost or subscription fees. The local version of Cap is 100% free with no usage limits.",
    },
    {
      title: "Unlimited Cloud Storage",
      description:
        "Store and share your recordings effortlessly with unlimited cloud storage.",
    },
    {
      title: "Advanced Team Collaboration",
      description:
        "Boost team productivity with features designed for efficient collaboration and easy sharing.",
    },
  ],

  useCasesTitle: "Popular Uses",
  useCasesDescription:
    "Explore how Cap can support your team's productivity and streamline your workflow",

  useCases: [
    {
      title: "Team Collaboration",
      description:
        "Enhance teamwork with easy screen sharing for feedback and collaboration.",
    },
    {
      title: "Tutorial Creation",
      description:
        "Quickly create engaging tutorials and instructional videos.",
    },
    {
      title: "Professional Presentations",
      description:
        "Record polished presentations and demos for clients or internal team use.",
    },
    {
      title: "Educational Content",
      description:
        "Develop high-quality educational videos or training materials with ease.",
    },
  ],

  faqsTitle: "Frequently Asked Questions",
  faqs: [
    {
      question: "Is Cap a free screen recorder?",
      answer:
        "Yes, Cap offers a powerful free version, making it one of the best free screen recorders available. The local version is 100% free with no usage limits, but Cap Pro is available for users who need additional features.",
    },
    {
      question: "How does Cap compare to OBS?",
      answer:
        "Cap is designed to be highly user-friendly while delivering high recording quality. It’s a simpler, yet powerful, alternative to OBS for users seeking an intuitive experience.",
    },
    {
      question: "Can I download Cap on multiple devices?",
      answer:
        "Yes, Cap is cross-platform and can be downloaded on macOS and Windows, allowing you to use it across multiple devices.",
    },
    {
      question: "What platforms does Cap support?",
      answer:
        "Cap is compatible with macOS and Windows, making it versatile for any user or team.",
    },
    {
      question: "How does Cap improve team productivity?",
      answer:
        "Cap’s advanced collaboration features make it easy to share, review, and provide feedback on screen recordings, helping teams work more effectively together.",
    },
  ],

  video: {
    url: "/videos/cap-demo.mp4",
    thumbnail: "/videos/cap-demo-thumbnail.png",
    alt: "Cap screen recorder demo showing high-quality and user-friendly features",
  },

  cta: {
    title:
      "Get Started with Cap – The Easy, High-Quality, and Free Screen Recorder",
    buttonText: "Download Cap Free",
  },
};

export const ScreenRecorderPage = () => {
  return <SeoPageTemplate content={screenRecorderContent} />;
};
