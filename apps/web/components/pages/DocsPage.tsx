import Link from "next/link";
import Image from "next/image";
import { getDocs } from "@/utils/blog";

export const DocsPage = () => {
  const allDocs = getDocs();

  return (
    <div className="wrapper wrapper-sm py-20">
      <div className="text-center page-intro mb-14">
        <h1>Documentation</h1>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {allDocs.map((doc) => (
          <article
            key={doc.slug}
            className="w-full rounded-xl overflow-hidden border"
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
                <h2 className="text-xl md:text-4xl text-gray-500">
                  {doc.metadata.title}
                </h2>
                <p className="text-gray-600">{doc.metadata.summary}</p>
                <div className="flex space-x-2">
                  {doc.metadata.tags &&
                    doc.metadata.tags.split(", ").map((tag) => (
                      <p
                        key={tag}
                        className="rounded-md bg-gray-200 font-medium px-2 py-0.5 text-sm text-gray-500"
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
