"use client";
import { useRouter } from "next/navigation";

export default function SharePage() {
  const router = useRouter();
  router.replace("/");
}
