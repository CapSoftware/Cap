"use client";

export const DashboardTemplate = ({
  title,
  description,
  button,
  children,
}: {
  title?: string;
  description?: string;
  button?: React.ReactNode;
  children?: React.ReactNode;
}) => {
  return <div className="dashboard-page">{children && children}</div>;
};
