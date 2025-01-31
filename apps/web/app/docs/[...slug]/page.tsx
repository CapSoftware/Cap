import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { MDXRemote } from "next-mdx-remote/rsc";
import { getDocs } from "@/utils/blog";
import type { Metadata } from "next";
import type { DocMetadata } from "@/utils/blog";
import { clientEnv } from "@cap/env";

type Doc = {
  metadata: DocMetadata;
  slug: string;
  content: string;
};

interface DocProps {
  params: {
    slug: string[];
  };
}

export async function generateMetadata(
  props: DocProps
): Promise<Metadata | undefined> {
  const { params } = props;
  if (!params?.slug) return;

  const fullSlug = params.slug.join("/");

  // If it's a category page
  if (params.slug.length === 1) {
    const category = params.slug[0];
    if (!category) return;

    const displayCategory = category
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    return {
      title: `${displayCategory} Documentation - Cap`,
      description: `Documentation for ${displayCategory} in Cap`,
    };
  }

  // If it's a doc page
  const allDocs = getDocs() as Doc[];
  const doc = allDocs.find((doc) => doc.slug === fullSlug);
  if (!doc) return;

  const { title, summary, image } = doc.metadata;
  const ogImage = image
    ? `${clientEnv.NEXT_PUBLIC_WEB_URL}${image}`
    : undefined;
  const description = summary || title;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      url: `${clientEnv.NEXT_PUBLIC_WEB_URL}/docs/${fullSlug}`,
      ...(ogImage && {
        images: [{ url: ogImage }],
      }),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      ...(ogImage && { images: [ogImage] }),
    },
  };
}

export default async function DocPage(props: DocProps) {
  const { params } = props;
  if (!params?.slug) notFound();

  const fullSlug = params.slug.join("/");
  const allDocs = getDocs() as Doc[];

  // Handle category pages (e.g., /docs/s3-config)
  if (params.slug.length === 1) {
    const category = params.slug[0];
    if (!category) notFound();

    // Find docs that either:
    // 1. Have a slug that exactly matches the category, or
    // 2. Have a slug that starts with category/
    const categoryDocs = allDocs
      .filter(
        (doc) => doc.slug === category || doc.slug.startsWith(`${category}/`)
      )
      .sort((a, b) => {
        // Sort by depth (root level first)
        const aDepth = a.slug.split("/").length;
        const bDepth = b.slug.split("/").length;
        if (aDepth !== bDepth) return aDepth - bDepth;

        // Then by title
        return a.metadata.title.localeCompare(b.metadata.title);
      });

    if (categoryDocs.length === 0) {
      notFound();
    }

    // Format the category name for display
    const displayCategory = category
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    // Find the root category doc if it exists
    const rootDoc = categoryDocs.find((doc) => doc.slug === category);

    return (
      <div className="py-8 prose mx-auto">
        <h1>{displayCategory} Documentation</h1>

        {/* Show root category content if it exists */}
        {rootDoc && (
          <div className="mb-8">
            <MDXRemote source={rootDoc.content} />
            <hr className="my-8" />
          </div>
        )}

        {/* Show subcategory docs */}
        {categoryDocs.length > (rootDoc ? 1 : 0) && (
          <>
            <h2 className="mt-0">Available Guides</h2>
            <div className="grid gap-4">
              {categoryDocs
                .filter((doc) => doc.slug !== category) // Filter out the root doc if it exists
                .map((doc) => (
                  <Link
                    key={doc.slug}
                    href={`/docs/${doc.slug}`}
                    className="no-underline"
                  >
                    <div className="p-4 rounded-lg border hover:border-blue-500 transition-colors">
                      <h3 className="m-0">{doc.metadata.title}</h3>
                      {doc.metadata.summary && (
                        <p className="text-gray-600 dark:text-gray-400 m-0 mt-2">
                          {doc.metadata.summary}
                        </p>
                      )}
                      {doc.metadata.tags && (
                        <div className="flex gap-2 mt-3">
                          {doc.metadata.tags.split(", ").map((tag) => (
                            <span
                              key={tag}
                              className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-gray-600 dark:text-gray-400"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </Link>
                ))}
            </div>
          </>
        )}
      </div>
    );
  }

  // Handle individual doc pages
  const doc = allDocs.find((doc) => doc.slug === fullSlug);

  if (!doc) {
    notFound();
  }

  return (
    <article className="py-8 prose mx-auto">
      {doc.metadata.image && (
        <div className="relative mb-12 h-[345px] w-full">
          <Image
            className="m-0 w-full rounded-lg object-contain sm:object-cover"
            src={doc.metadata.image}
            alt={doc.metadata.title}
            fill
            priority
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          />
        </div>
      )}

      <div className="wrapper">
        <header>
          <h1 className="mb-2">{doc.metadata.title}</h1>
        </header>
        <hr className="my-6" />
        <MDXRemote source={doc.content} />
      </div>
    </article>
  );
}
