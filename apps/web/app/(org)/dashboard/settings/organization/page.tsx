import { Metadata } from "next";
import { Organization } from "./Organization";

export const metadata: Metadata = {
  title: "Organization Settings — Cap",
};

export const revalidate = 0;

export default function OrganizationPage() {
  return <Organization />;
}
