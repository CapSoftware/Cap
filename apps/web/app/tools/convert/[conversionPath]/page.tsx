import { Metadata } from "next";
import {
  MediaFormatConverter,
  parseFormats,
  CONVERSION_CONFIGS,
} from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import { notFound } from "next/navigation";
import { ToolPageContent } from "@/components/tools/types";

interface ConversionPageProps {
  params: {
    conversionPath: string;
  };
}

export async function generateMetadata({
  params,
}: ConversionPageProps): Promise<Metadata> {
  const { conversionPath } = params;

  if (!CONVERSION_CONFIGS[conversionPath]) {
    return {
      title: "Conversion Not Supported",
      description: "This conversion type is not supported.",
    };
  }

  const { sourceFormat, targetFormat } = parseFormats(conversionPath);
  const config = CONVERSION_CONFIGS[conversionPath];

  return {
    title: `${sourceFormat.toUpperCase()} to ${targetFormat.toUpperCase()} Converter | Free Online Tool`,
    description: config.description(sourceFormat, targetFormat),
  };
}

export async function generateStaticParams() {
  return Object.keys(CONVERSION_CONFIGS).map((path) => ({
    conversionPath: path,
  }));
}

export default function ConversionPage({ params }: ConversionPageProps) {
  const { conversionPath } = params;

  if (!CONVERSION_CONFIGS[conversionPath]) {
    notFound();
  }

  const { sourceFormat, targetFormat } = parseFormats(conversionPath);
  const config = CONVERSION_CONFIGS[conversionPath];

  const pageContent: ToolPageContent = {
    title: config.title(sourceFormat, targetFormat),
    description: config.description(sourceFormat, targetFormat),
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
          "We use industry-standard FFmpeg technology to ensure high-quality conversion results.",
      },
    ],
    faqs: [
      {
        question: `How does the ${sourceFormat.toUpperCase()} to ${targetFormat.toUpperCase()} converter work?`,
        answer: `Our converter uses WebAssembly to run FFmpeg directly in your browser. When you upload a ${sourceFormat.toUpperCase()} file, it gets processed locally on your device and converted to ${targetFormat.toUpperCase()} format without ever being sent to a server.`,
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
        <MediaFormatConverter initialConversionPath={conversionPath} />
      }
    />
  );
}
