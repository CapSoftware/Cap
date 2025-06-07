import { PricingPage } from "@/components/pages/PricingPage";
import { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "Early Adopter Pricing — Cap",
};

export default function App() {
  return (
    <Suspense>
      <PricingPage />
    </Suspense>
  );
}
