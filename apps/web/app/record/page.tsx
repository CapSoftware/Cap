import { redirect } from "next/navigation";
import { Record } from "./Record";
import { getCurrentUser } from "@cap/database/auth/session";

export const revalidate = 0;

export default async function RecordPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return <Record user={user} />;
}
