import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
	CONVERSION_CONFIGS,
	MediaFormatConverter,
	parseFormats,
} from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";
import { createBreadcrumbSchema } from "@/utils/web-schema";

interface ConversionPageProps {
	params: Promise<{
		conversionPath: string;
	}>;
}

export async function generateMetadata(
	props: ConversionPageProps,
): Promise<Metadata> {
	const params = await props.params;
	const { conversionPath } = params;

	if (!CONVERSION_CONFIGS[conversionPath]) {
		return {
			title: "Conversion Not Supported | Cap",
			description:
				"This conversion type is not supported by our free online tools.",
		};
	}

	const { sourceFormat, targetFormat } = parseFormats(conversionPath);
	const config = CONVERSION_CONFIGS[conversionPath];
	const sourceUpper = sourceFormat.toUpperCase();
	const targetUpper = targetFormat.toUpperCase();

	return {
		title: `${sourceUpper} to ${targetUpper} Converter | Free Online Tool | Cap`,
		description: `${config.description(
			sourceFormat,
			targetFormat,
		)} Free online converter with no uploads needed for maximum privacy.`,
		openGraph: {
			title: `${sourceUpper} to ${targetUpper} Converter | Free Online Tool`,
			description: `Convert ${sourceUpper} files to ${targetUpper} format directly in your browser. No uploads required, processing happens locally for maximum privacy.`,
			images: [
				{
					url: "/og.png",
					width: 1200,
					height: 630,
					alt: `Cap ${sourceUpper} to ${targetUpper} Converter Tool`,
				},
			],
		},
		alternates: {
			canonical: `https://cap.so/tools/convert/${conversionPath}`,
		},
	};
}

export async function generateStaticParams() {
	return Object.keys(CONVERSION_CONFIGS).map((path) => ({
		conversionPath: path,
	}));
}

export default async function ConversionPage(props: ConversionPageProps) {
	const params = await props.params;
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
					"We use browser technology to ensure high-quality and fast conversion results.",
			},
		],
		faqs: [
			{
				question: `How does the ${sourceFormat.toUpperCase()} to ${targetFormat.toUpperCase()} converter work?`,
				answer: `Our converter uses Remotion (remotion.dev) directly in your browser. When you upload a ${sourceFormat.toUpperCase()} file, it gets processed locally on your device and converted to ${targetFormat.toUpperCase()} format without ever being sent to a server.`,
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

	const breadcrumbSchema = createBreadcrumbSchema([
		{ name: "Home", url: "https://cap.so" },
		{ name: "Tools", url: "https://cap.so/tools" },
		{ name: "Convert", url: "https://cap.so/tools/convert" },
		{
			name: config.title(sourceFormat, targetFormat),
			url: `https://cap.so/tools/convert/${conversionPath}`,
		},
	]);

	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(breadcrumbSchema),
				}}
			/>
			<ToolsPageTemplate
				content={pageContent}
				toolComponent={
					<MediaFormatConverter initialConversionPath={conversionPath} />
				}
			/>
		</>
	);
}
