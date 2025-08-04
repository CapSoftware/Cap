"use client";

import { getDocs } from "@/utils/blog";
import { MDXRemote } from "next-mdx-remote/rsc";
import Image from "next/image";

export const DocPage = ({ docSlug }: { docSlug: string }) => {
  const doc = getDocs().find((doc) => doc.slug === docSlug);

  if (!doc) {
    return null;
  }

  return (
    <article className="py-32 mx-auto md:py-40 prose">
      {doc.metadata.image && (
        <div className="relative mb-12 h-[345px] w-full">
          <Image
            className="object-cover m-0 w-full rounded-lg"
            src={doc.metadata.image}
            alt={doc.metadata.title}
            fill
            quality={100}
            priority
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          />
        </div>
      )}

      <header>
        <h1 className="mb-2">{doc.metadata.title}</h1>
      </header>
      <hr className="my-6" />
      <MDXRemote source={doc.content} />
    </article>
  );
};
