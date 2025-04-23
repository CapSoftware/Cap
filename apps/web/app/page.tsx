import { HomePage } from "@/components/pages/HomePage";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function Home() {
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get("next-auth.session-token");

  if (sessionCookie) {
    redirect("/dashboard/caps");
  }

  return <HomePage />;
}
