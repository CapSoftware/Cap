import { Metadata } from "next";
import { Workspace } from "./Workspace";

export const metadata: Metadata = {
  title: "Workspace Settings — Cap",
};

export const revalidate = 0;

export default function BillingPage() {
  return <Workspace />;
}
