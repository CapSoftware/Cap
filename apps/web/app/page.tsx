import { HomePage } from "@/components/pages/HomePage";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getBootstrapData } from "@/utils/getBootstrapData";

export default async function Home() {
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get("next-auth.session-token");
  const bootstrapData = await getBootstrapData();

  const homepageCopyVariant =
    (bootstrapData.featureFlags["homepage-copy"] as string) || "";

  if (sessionCookie) {
    redirect("/dashboard/caps");
  }

  return <HomePage serverHomepageCopyVariant={homepageCopyVariant} />;
}
