import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import { ToolPageContent } from "@/components/tools/types";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "WebM to MP4 Converter | Free Online Video Converter | Cap",
  description:
    "Convert WebM videos to MP4 format directly in your browser with our free online converter. No uploads, no installation, 100% private.",
  openGraph: {
    title: "WebM to MP4 Converter | Free Online Video Converter",
    description:
      "Convert WebM videos to MP4 format directly in your browser. No uploads required, processing happens locally for maximum privacy.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Cap WebM to MP4 Converter Tool",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "WebM to MP4 Converter | Free Online Video Converter",
    description:
      "Convert WebM videos to MP4 format directly in your browser. No uploads required, processing happens locally for maximum privacy.",
    images: ["/og.png"],
  },
};

export default function WebmToMp4Page() {
  const pageContent: ToolPageContent = {
    title: "WebM to MP4 Converter",
    description: "Convert WebM videos to MP4 format directly in your browser",
    featuresTitle: "Features",
    featuresDescription:
      "Our free online converter offers several advantages over other conversion services:",
    features: [
      {
        title: "100% Private",
        description:
          "Your files never leave your device. All processing happens right in your browser.",
      },
      {
        title: "No Installation Required",
        description:
          "No need to download or install any software. Just open the page and start converting.",
      },
      {
        title: "High Quality Conversion",
        description:
          "We use browser technology to ensure high-quality and fast conversion results.",
      },
    ],
    faqs: [
      {
        question: "How does the WebM to MP4 converter work?",
        answer:
          "Our converter uses Remotion (remotion.dev) directly in your browser. When you upload a WebM file, it gets processed locally on your device and converted to MP4 format without ever being sent to a server.",
      },
      {
        question: "Is there a file size limit?",
        answer:
          "Yes, currently we limit file sizes to 500MB to ensure smooth performance in the browser. For larger files, you might need to use a desktop application.",
      },
      {
        question: "Why should I use this converter instead of others?",
        answer:
          "Unlike many online converters that require uploading your files to their servers, our tool processes everything locally. This means your files never leave your device, providing maximum privacy and security.",
      },
    ],
    cta: {
      title: "Cap is the open source Loom alternative",
      description:
        "Record, edit, and share video messages with Cap. 100% open source and privacy focused.",
      buttonText: "Download Cap Free",
    },
  };

  return (
    <ToolsPageTemplate
      content={pageContent}
      toolComponent={
        <MediaFormatConverter initialConversionPath="webm-to-mp4" />
      }
    />
  );
}
