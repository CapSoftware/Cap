import { getDocs } from "@/utils/blog";
import { clientEnv, serverEnv } from "@cap/env";
import type { Metadata } from "next";
import { MDXRemote } from "next-mdx-remote/rsc";
import Image from "next/image";
import { notFound } from "next/navigation";

interface DocProps {
  params: {
    slug: string;
  };
}

export async function generateMetadata({
  params,
}: DocProps): Promise<Metadata | undefined> {
  let doc = getDocs().find((doc) => doc.slug === params.slug);
  if (!doc) {
    return;
  }

  let { title, summary: description, image } = doc.metadata;
  let ogImage = image ? `${serverEnv.WEB_URL}${image}` : undefined;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      url: `${serverEnv.WEB_URL}/docs/${doc.slug}`,
      ...(ogImage && {
        images: [
          {
            url: ogImage,
          },
        ],
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

export default async function DocPage({ params }: DocProps) {
  const doc = getDocs().find((doc) => doc.slug === params.slug);

  if (!doc) {
    notFound();
  }

  return (
    <article className="py-32 mx-auto prose">
      {doc.metadata.image && (
        <div className="relative mb-12 h-[345px] w-full">
          <Image
            className="object-contain m-0 w-full rounded-lg sm:object-cover"
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
