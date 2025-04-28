import { SpeedController } from "@/components/tools/SpeedController";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";

const content = {
  title: "Video Speed Controller",
  description: "Speed up or slow down your videos directly in your browser",
  featuresTitle: "Why Use Our Video Speed Controller",
  featuresDescription:
    "Our free video speed controller tool runs entirely in your browser, respecting your privacy while delivering professional results.",
  features: [
    {
      title: "100% Private",
      description:
        "All processing happens locally in your browser. Your videos never leave your device.",
    },
    {
      title: "Multiple Speed Options",
      description:
        "Choose from various speed settings from super slow (0.25x) to ultra fast (3x) to achieve the perfect timing.",
    },
    {
      title: "Preserves Audio Quality",
      description:
        "Unlike basic tools, we adjust audio pitch to sound natural at different speeds.",
    },
  ],
  faqs: [
    {
      question: "What video formats are supported?",
      answer:
        "Our tool supports most common video formats including MP4, WebM, MOV, AVI, and MKV.",
    },
    {
      question: "Is there a file size limit?",
      answer:
        "Yes, the maximum file size is 500MB. This limit ensures optimal performance in the browser.",
    },
    {
      question: "Will the video quality be reduced?",
      answer:
        "No, our tool maintains the original resolution of your video while adjusting its speed.",
    },
    {
      question: "Why is video processing slow?",
      answer:
        "Processing happens completely in your browser, so speed depends on your device's performance. Larger videos will take longer to process.",
    },
    {
      question: "Can I use this on my phone?",
      answer:
        "Yes, this tool works on modern mobile browsers, but processing may be faster on desktop devices.",
    },
  ],
  cta: {
    title: "Looking for more powerful video tools?",
    description:
      "Download Cap - the open source screen recorder with built-in editing capabilities",
    buttonText: "Get Cap for Free",
  },
};

export default function SpeedControllerPage() {
  return (
    <ToolsPageTemplate content={content} toolComponent={<SpeedController />} />
  );
}

export const metadata = {
  title: "Video Speed Controller - Speed Up or Slow Down Videos Online",
  description:
    "Free browser-based tool to adjust video playback speed. Speed up or slow down videos without losing quality, all processed locally for privacy.",
};
