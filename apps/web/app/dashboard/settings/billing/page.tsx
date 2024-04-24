import { Billing } from "./Billing";
import { getCurrentUser } from "@cap/database/auth/session";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Billing Settings — Cap",
};

export const revalidate = 0;

export default async function BillingPage() {
  const user = await getCurrentUser();

  return <Billing user={user} />;
}
