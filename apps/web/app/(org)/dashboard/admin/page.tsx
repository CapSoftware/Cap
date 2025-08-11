import { redirect } from "next/navigation";
import { getCurrentUser } from "@cap/database/auth/session";
import AdminDashboardClient from "./AdminDashboardClient";

export default async function AdminDashboard() {
  const currentUser = await getCurrentUser();

  if (currentUser?.email !== "richie@mcilroy.co") {
    redirect("/dashboard");
  }

  return <AdminDashboardClient />;
}
