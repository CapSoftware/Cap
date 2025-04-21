import { HomePage } from "@/components/pages/HomePage";
import { authOptions } from "@cap/database/auth/auth-options";
import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { Metadata } from "next";

export default async function Home() {
  const session = await getServerSession(authOptions);

  if (session?.user) {
    redirect("/dashboard/caps");
  }

  return <HomePage />;
}

export const metadata: Metadata = {
  title: "OPAVC — Ontario Provincial Autism Ventures Corporation",
  description: "OPAVC is dedicated to supporting and empowering individuals with autism through innovative solutions and community engagement.",
};
