import { Billing } from "./Billing";
import { getCurrentUser } from "@cap/database/auth/session";

export const revalidate = 0;

export default async function BillingPage() {
  const user = await getCurrentUser();

  return <Billing user={user} />;
}
