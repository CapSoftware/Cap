import { getPageBySlug } from "@/lib/seo-pages";
import { getMetadataBySlug } from "@/lib/seo-metadata";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

type Props = {
  params: { slug: string };
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const metadata = getMetadataBySlug(params.slug);

  if (!metadata) {
    return {
      title: "OPAVC — Professional Screen Recording Platform",
      description: "Professional screen recording platform by OPAVC",
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
