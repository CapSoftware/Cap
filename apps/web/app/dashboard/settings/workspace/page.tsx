import { Workspace } from "./Workspace";
import { Metadata } from "next";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";

export const metadata: Metadata = {
  title: "Workspace Settings — Cap",
};

export const revalidate = 0;

export default async function BillingPage() {
  return <Workspace />;
}
