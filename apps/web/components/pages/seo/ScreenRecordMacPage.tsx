"use client";

import { SeoPageTemplate } from "../../seo/SeoPageTemplate";

export const screenRecordMacContent = {
  title: "Screen Record on Mac: High-Quality, Easy-to-Use Recorder for macOS",
  description:
    "Cap is a powerful, user-friendly screen recorder for Mac, offering high-quality video capture with seamless functionality. Perfect for creating tutorials, presentations, and educational content on macOS.",

  featuresTitle: "Why Choose Cap for Screen Recording on Mac?",
  featuresDescription:
    "Cap provides all the features Mac users need for stunning, high-quality screen recordings",

  features: [
    {
      title: "Optimized for macOS",
      description:
        "Cap is fully optimized for Mac, delivering smooth performance and seamless integration with macOS.",
    },
    {
      title: "High-Quality Video Capture",
      description:
        "Record clear, high-definition video with synced audio, perfect for professional use.",
    },
    {
      title: "User-Friendly Interface",
      description:
        "Designed for ease of use on Mac, Cap offers an intuitive setup and simple recording options.",
    },
    {
      title: "Unlimited Recording Time",
      description:
        "Record for as long as you need with no restrictions on recording time, ideal for extended presentations.",
    },
    {
      title: "Easy Export and Sharing",
      description:
        "Save and share your recordings effortlessly with Cap’s built-in export options for Mac.",
    },
  ],

  useCasesTitle: "Popular Uses for Cap’s Screen Recorder on Mac",
  useCasesDescription:
    "Explore how Cap’s screen recorder enhances productivity on macOS",

  useCases: [
    {
      title: "Creating Tutorials",
      description:
        "Easily create detailed tutorials or training videos on your Mac.",
    },
    {
      title: "Professional Presentations",
      description:
        "Record high-quality presentations and demos to share with colleagues or clients.",
    },
    {
      title: "Educational Content",
      description:
        "Develop engaging educational videos or lectures for students or training materials.",
    },
    {
      title: "Remote Team Collaboration",
      description:
        "Share recorded screen content with your team to facilitate remote feedback and collaboration.",
    },
  ],

  faqsTitle: "Frequently Asked Questions",
  faqs: [
    {
      question: "Is Cap compatible with macOS?",
      answer:
        "Yes, Cap is fully compatible with macOS and optimized to work seamlessly on Mac devices.",
    },
    {
      question: "Can I record my screen with audio on Mac?",
      answer:
        "Yes, Cap allows you to record high-quality screen videos with audio, making it perfect for presentations and tutorials.",
    },
    {
      question: "How do I export recordings from Cap on my Mac?",
      answer:
        "Cap offers easy export options, allowing you to save your recordings in various formats directly from your Mac.",
    },
    {
      question: "Can I use Cap for free on Mac?",
      answer:
        "Yes, Cap offers a free version with powerful features for Mac users, including unlimited recording time and high-quality video capture.",
    },
    {
      question: "What are the best uses for Cap on Mac?",
      answer:
        "Cap is ideal for creating tutorials, recording presentations, producing educational content, and supporting remote collaboration.",
    },
  ],

  video: {
    url: "/videos/cap-mac-screen-recorder-demo.mp4",
    thumbnail: "/videos/cap-mac-screen-recorder-thumbnail.png",
    alt: "Cap screen recorder demo on macOS showing high-quality recording",
  },

  cta: {
    title: "Get Started with Cap – The Best Screen Recorder for Mac",
    buttonText: "Download Cap Free for Mac",
  },
};

export const ScreenRecordMacPage = () => {
  return <SeoPageTemplate content={screenRecordMacContent} />;
};
