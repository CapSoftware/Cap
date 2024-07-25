import { redirect } from "next/navigation";
import { Record } from "./Record";
import { getCurrentUser } from "@cap/database/auth/session";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export const revalidate = 0;

const client = new QueryClient();

export default async function RecordPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <QueryClientProvider client={client}>
      <Record user={user} />
    </QueryClientProvider>
  );
}
