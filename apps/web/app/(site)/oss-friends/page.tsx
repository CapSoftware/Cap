import { Metadata } from "next";
import { ExternalLink } from "lucide-react";

export const metadata: Metadata = {
  title: "OSS Friends — Cap",
  description:
    "Discover amazing open source projects and tools built by our friends in the community.",
};

interface OSSFriend {
  name: string;
  description: string;
  href: string;
}

interface OSSFriendsResponse {
  data: OSSFriend[];
}

async function fetchOSSFriends(): Promise<OSSFriendsResponse> {
  const response = await fetch("https://formbricks.com/api/oss-friends", {
    next: { revalidate: 3600 },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch OSS friends");
  }

  const data = await response.json();

  const filteredData = {
    ...data,
    data: data.data.filter((friend: any) => friend.name !== "Cap"),
  };

  return filteredData;
}

export default async function OSSFriends() {
  const data = await fetchOSSFriends();

  return (
    <div className="mt-[120px]">
      <div className="relative z-10 px-5 pt-24 pb-36 w-full">
        <div className="mx-auto text-center wrapper wrapper-sm mb-16">
          <h1 className="fade-in-down text-[2rem] leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] relative z-10 text-black mb-4">
            OSS Friends
          </h1>
          <p className="mx-auto mb-8 max-w-3xl text-md sm:text-xl text-zinc-500 fade-in-down animate-delay-1">
            Discover amazing open source projects and tools built by our friends
            in the community.
          </p>
        </div>

        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 fade-in-up animate-delay-2">
            {data.data.map((friend, index) => (
              <a
                key={friend.name}
                href={friend.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group bg-white border border-gray-200 rounded-lg p-6 hover:border-gray-300 hover:shadow-md transition-all duration-200 hover:-translate-y-1"
                style={{
                  animationDelay: `${index * 50}ms`,
                }}
              >
                <div className="flex items-start justify-between mb-3">
                  <h3 className="text-lg font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                    {friend.name}
                  </h3>
                  <ExternalLink className="w-5 h-5 text-gray-400 group-hover:text-blue-600 transition-colors flex-shrink-0 ml-2" />
                </div>
                <p className="text-gray-600 text-sm leading-relaxed">
                  {friend.description}
                </p>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
