import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { getCareerPosts } from "@/utils";
import type { Metadata } from "next";

interface PostProps {
  params: {
    slug: string;
  };
}

export async function generateMetadata({
  params,
}: PostProps): Promise<Metadata | undefined> {
  const posts = await getCareerPosts();
  const position = posts.find((post) => post.slug === params.slug);
  if (!position) {
    return;
  }

  const { title, description } = position.metadata;

  return {
    title: `${title} - Careers at Cap`,
    description,
    openGraph: {
      title: `${title} - Careers at Cap`,
      description,
      type: "website",
      url: `${process.env.NEXT_PUBLIC_URL}/careers/${position.slug}`,
    },
    twitter: {
      card: "summary",
      title: `${title} - Careers at Cap`,
      description,
    },
  };
}

export default async function CareerPage({ params }: PostProps) {
  const posts = await getCareerPosts();
  const position = posts.find((post) => post.slug === params.slug);

  if (!position) {
    notFound();
  }

  return (
    <article className="py-8 prose mx-auto">
      <div className="wrapper wrapper-sm">
        <header className="mb-8">
          <h1 className="mb-2">{position.metadata.title}</h1>
          <div className="flex space-x-4 text-gray-500">
            <span>{position.metadata.type}</span>
            <span>•</span>
            <span>{position.metadata.location}</span>
            <span>•</span>
            <span>
              Posted{" "}
              {format(parseISO(position.metadata.publishedAt), "MMMM d, yyyy")}
            </span>
          </div>
        </header>
        <hr className="my-6" />
        {position.content}
        <div className="mt-8 text-center">
          <a
            href={`mailto:careers@cap.so?subject=Application for ${position.metadata.title}`}
            className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2 bg-blue-500 text-white"
          >
            Apply for this Position
          </a>
        </div>
      </div>
    </article>
  );
}
