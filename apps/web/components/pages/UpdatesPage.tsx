import Link from "next/link";
import Image from "next/image";
import { format, parseISO } from "date-fns";
import { getBlogPosts } from "@/utils/updates";

export const UpdatesPage = () => {
  const allUpdates = getBlogPosts();

  return (
    <div className="wrapper wrapper-sm py-20">
      <div className="text-center page-intro mb-14">
        <h1>Updates</h1>
      </div>
      <div>
        <div className="space-y-8">
          {allUpdates
            .slice()
            .reverse()
            .map((post) => (
              <article
                key={post.slug}
                className="w-full rounded-xl overflow-hidden border"
              >
                <Link href={"/updates/" + post.slug}>
                  {post.metadata.image && (
                    <div className="w-full border-b">
                      <Image
                        src={post.metadata.image}
                        width={900}
                        height={400}
                        objectFit="cover"
                        alt={post.metadata.title}
                        className="w-full h-auto"
                      />
                    </div>
                  )}
                  <div className="p-10 space-y-4">
                    <h2 className="text-xl md:text-4xl text-gray-500">
                      {post.metadata.title}
                    </h2>
                    <div className="flex space-x-2">
                      <p className="text-gray-600">by {post.metadata.author}</p>
                      <span>{` • `}</span>
                      <p className="text-gray-600">
                        {format(
                          parseISO(post.metadata.publishedAt),
                          "MMMM dd, yyyy"
                        )}
                      </p>
                    </div>
                    <div className="flex space-x-2">
                      {post.metadata.tags &&
                        post.metadata.tags
                          .split(", ")
                          .map((tag) => (
                            <p className="rounded-md bg-gray-200 font-medium px-2 py-0.5 text-sm text-gray-500">
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
    </div>
  );
};
