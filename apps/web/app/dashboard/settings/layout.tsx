"use client";

import DashboardInner from "../_components/DashboardInner";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardInner title="Settings">{children}</DashboardInner>;
}
