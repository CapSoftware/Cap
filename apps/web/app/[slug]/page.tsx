import { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPageBySlug, seoPages } from "../../lib/seo-pages";
import { getMetadataBySlug } from "../../lib/seo-metadata";

interface PageProps {
  params: {
    slug: string;
  };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const metadata = getMetadataBySlug(params.slug);

  if (!metadata) {
    return {};
  }

  return {
    title: metadata.title,
    description: metadata.description,
    keywords: metadata.keywords,
    openGraph: {
      title: metadata.title,
      description: metadata.description,
      images: metadata.ogImage
        ? [
            {
              url: metadata.ogImage,
              width: 1200,
              height: 630,
              alt: metadata.title,
            },
          ]
        : [],
    },
  };
}

export default function Page({ params }: PageProps) {
  const page = getPageBySlug(params.slug);

  if (!page) {
    notFound();
  }

  const PageComponent = page.component;
  return <PageComponent />;
}

export async function generateStaticParams() {
  return Object.keys(seoPages).map((slug) => ({
    slug,
  }));
}
