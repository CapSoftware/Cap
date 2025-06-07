import { getDocs } from "@/utils/blog";
import Image from "next/image";
import Link from "next/link";

export const DocsPage = () => {
  const allDocs = getDocs();

  return (
    <div className="px-5 py-32 mx-auto sm:py-32 wrapper wrapper-sm">
      <div className="mb-14 text-center page-intro">
        <h1>Documentation</h1>
      </div>
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        {allDocs.map((doc) => (
          <article
            key={doc.slug}
            className="overflow-hidden w-full rounded-xl border"
          >
            <Link href={"/docs/" + doc.slug}>
              {doc.metadata.image && (
                <div className="w-full border-b">
                  <Image
                    src={doc.metadata.image}
                    width={900}
                    height={400}
                    objectFit="cover"
                    alt={doc.metadata.title}
                    className="w-full h-auto"
                  />
                </div>
              )}
              <div className="p-10 space-y-4">
                <h2 className="text-xl text-gray-1 md:text-4xl">
                  {doc.metadata.title}
                </h2>
                <p className="text-gray-600">{doc.metadata.summary}</p>
                <div className="flex space-x-2">
                  {doc.metadata.tags &&
                    doc.metadata.tags.split(", ").map((tag) => (
                      <p
                        key={tag}
                        className="rounded-md bg-gray-200 font-medium px-2 py-0.5 text-sm text-gray-1"
                      >
                        {tag}
                      </p>
                    ))}
                </div>
              </div>
            </Link>
          </article>
        ))}
      </div>
    </div>
  );
};
