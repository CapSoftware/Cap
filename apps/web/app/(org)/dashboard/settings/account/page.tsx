import { Settings } from "./Settings";
import { getCurrentUser } from "@cap/database/auth/session";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Settings — Cap",
};

export default async function SettingsPage() {
  const user = await getCurrentUser();

  return <Settings user={user} />;
}
