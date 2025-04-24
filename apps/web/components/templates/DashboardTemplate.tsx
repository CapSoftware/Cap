"use client";

import DashboardInner from "@/app/dashboard/_components/DashboardInner";

export const DashboardTemplate = ({
  children,
}: {
  children?: React.ReactNode;
}) => {
  return (
    <div className="dashboard-page">
      <DashboardInner emptyComponent={children}>
        {children && children}
      </DashboardInner>
    </div>
  );
};
