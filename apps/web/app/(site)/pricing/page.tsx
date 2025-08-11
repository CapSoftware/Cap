import { PricingPage } from "@/components/pages/PricingPage";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Early Adopter Pricing — Cap",
};

export default function App() {
  return <PricingPage />;
}
