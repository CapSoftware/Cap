import { HomePage } from "@/components/pages/HomePage";
import { authOptions } from "@cap/database/auth/auth-options";
import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";

export default async function Home() {
  const session = await getServerSession(authOptions);

  if (session?.user) {
    redirect("/dashboard/caps");
  }

  return <HomePage />;
}
