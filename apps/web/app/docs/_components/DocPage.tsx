"use client";

import Image from "next/image";
import { MDXRemote } from "next-mdx-remote/rsc";
import { getDocs } from "@/utils/updates";

export const DocPage = ({ docSlug }: { docSlug: string }) => {
  const doc = getDocs().find((doc) => doc.slug === docSlug);

  if (!doc) {
    return null;
  }

  return (
    <article className="py-8 prose mx-auto">
      {doc.metadata.image && (
        <div className="relative mb-12 h-[345px] w-full">
          <Image
            className="m-0 w-full rounded-lg object-cover"
            src={doc.metadata.image}
            alt={doc.metadata.title}
            fill
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
