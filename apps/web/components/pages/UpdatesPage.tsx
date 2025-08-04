import { BlogPost, getBlogPosts, PostMetadata } from "@/utils/blog";
import { format, parseISO } from "date-fns";
import Image from "next/image";
import Link from "next/link";

const FEATURED_SLUGS = ["handling-a-stripe-payment-attack", "cap-v03-launch"];

export const UpdatesPage = () => {
  const allUpdates = getBlogPosts() as BlogPost[];

  const featuredPosts = allUpdates
    .filter((post) => FEATURED_SLUGS.includes(post.slug))
    // Sort featured posts by date (newest first)
    .sort((a, b) => {
      if ("publishedAt" in a.metadata && "publishedAt" in b.metadata) {
        return (
          new Date(b.metadata.publishedAt).getTime() -
          new Date(a.metadata.publishedAt).getTime()
        );
      }
      return 0;
    });

  const remainingPosts = allUpdates
    .filter((post) => !FEATURED_SLUGS.includes(post.slug))
    .sort((a, b) => {
      // Sort by published date in descending order
      if ("publishedAt" in a.metadata && "publishedAt" in b.metadata) {
        return (
          new Date(b.metadata.publishedAt).getTime() -
          new Date(a.metadata.publishedAt).getTime()
        );
      }
      return 0;
    });

  return (
    <div className="py-32 md:py-40 wrapper wrapper-sm">

      {featuredPosts.length > 0 && (
        <div className="mb-6">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {featuredPosts.map((post) => (
              <article
                key={post.slug}
                className="overflow-hidden w-full rounded-xl border transition-shadow bg-gray-1 border-gray-5 hover:shadow-md"
              >
                <Link href={`/blog/${post.slug}`}>
                  {post.metadata.image && (
                    <div className="w-full border-b">
                      <Image
                        src={post.metadata.image}
                        width={900}
                        height={400}
                        objectFit="cover"
                        alt={post.metadata.title}
                        className="object-cover w-full h-48"
                      />
                    </div>
                  )}
                  <div className="p-6 space-y-3">
                    <h3 className="text-xl font-semibold text-gray-12">
                      {post.metadata.title}
                    </h3>
                    <div className="flex space-x-2 text-sm">
                      {"author" in post.metadata && (
                        <>
                          <p className="text-gray-10">
                            by {(post.metadata as PostMetadata).author}
                          </p>
                          <span>{` • `}</span>
                        </>
                      )}
                      {"publishedAt" in post.metadata && (
                        <p className="text-gray-10">
                          {format(
                            parseISO(
                              (post.metadata as PostMetadata).publishedAt
                            ),
                            "MMMM dd, yyyy"
                          )}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {post.metadata.tags &&
                        post.metadata.tags.split(", ").map((tag, index) => (
                          <p
                            key={index}
                            className="rounded-md bg-gray-3 font-medium px-2 py-0.5 text-sm text-gray-12"
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
      )}

      <div>
        <div className="space-y-8">
          {remainingPosts.map((post) => (
            <article
              key={post.slug}
              className="overflow-hidden w-full rounded-xl border bg-gray-1 border-gray-5"
            >
              <Link href={`/blog/${post.slug}`}>
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
                  <h2 className="text-xl text-gray-12 md:text-4xl">
                    {post.metadata.title}
                  </h2>
                  <div className="flex space-x-2">
                    {"author" in post.metadata && (
                      <>
                        <p className="text-gray-10">
                          by {(post.metadata as PostMetadata).author}
                        </p>
                        <span>{` • `}</span>
                      </>
                    )}
                    {"publishedAt" in post.metadata && (
                      <p className="text-gray-10">
                        {format(
                          parseISO((post.metadata as PostMetadata).publishedAt),
                          "MMMM dd, yyyy"
                        )}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {post.metadata.tags &&
                      post.metadata.tags.split(", ").map((tag, index) => (
                        <p
                          key={index}
                          className="rounded-md bg-gray-3 font-medium px-2 py-0.5 text-sm text-gray-12"
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
    </div>
  );
};
