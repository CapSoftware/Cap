import Image from "next/image";
import Link from "next/link";
import { parseAuthors } from "@/utils/authors";

interface AuthorBylineProps {
  authors: string;
}

export function AuthorByline({ authors }: AuthorBylineProps) {
  const authorList = parseAuthors(authors);

  if (authorList.length === 0) {
    return null;
  }

  return (
    <div className="mt-16 pt-8 border-t border-gray-200">
      <div className="flex flex-wrap gap-6">
        {authorList.map((author, index) => (
          <div key={author.name} className="flex items-center space-x-3">
            <Image
              src={author.image}
              alt={author.name}
              width={48}
              height={48}
              className="w-10 h-10 rounded-full object-cover"
            />
            <div>
              <div className="font-medium text-gray-900">{author.name}</div>
              <Link
                href={`https://x.com/${author.handle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:text-blue-700 transition-colors"
              >
                @{author.handle}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
