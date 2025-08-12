import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMetadataBySlug } from "@/lib/seo-metadata";
import { getPageBySlug } from "@/lib/seo-pages";

type Props = {
	params: { slug: string };
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
	const metadata = getMetadataBySlug(params.slug);

	if (!metadata) {
		return {
			title: "Cap — Beautiful screen recordings, owned by you.",
			description:
				"Cap is the open source alternative to Loom. Lightweight, powerful, and cross-platform. Record and share in seconds.",
		};
	}

	return {
		title: metadata.title,
		description: metadata.description,
		keywords: metadata.keywords,
		openGraph: {
			title: metadata.title,
			description: metadata.description,
			images: [metadata.ogImage],
		},
	};
}

export default function SeoPage({ params }: Props) {
	const page = getPageBySlug(params.slug);

	if (!page) {
		notFound();
	}

	const PageComponent = page.component;
	return <PageComponent />;
}
