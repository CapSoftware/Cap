"use client";

import { Button } from "@cap/ui";
import type { ReactNode } from "react";

import { AppStatusBadge } from "../components/AppStatusBadge.tsx";
import { useAppsUi } from "../context.tsx";
import type { AppsUiContextValue } from "../context.tsx";
import type {
  AppManagementComponent,
  AppManagementComponentProps,
} from "../types.ts";

type PanelLayout = {
  title: string;
  description?: string;
  status: Parameters<typeof AppStatusBadge>[0]["status"];
  lastCheckedLabel?: string | null;
  sections: ReactNode;
  actions?: ReactNode;
  summary?: ReactNode;
  side?: ReactNode;
  onClose?: (() => void) | null;
};

type PanelBuilderProps = AppManagementComponentProps & {
  ui: AppsUiContextValue;
};

const createManagementPanel = (
  build: (props: PanelBuilderProps) => PanelLayout
): AppManagementComponent => {
  const ManagementPanel = (props: AppManagementComponentProps) => {
    const ui = useAppsUi();
    const layout = build({ ...props, ui });
    const hasSide = Boolean(layout.side);
    const { definition } = props.selection;
    const appInitial =
      definition.displayName?.[0]?.toUpperCase() ?? definition.slug[0]?.toUpperCase() ?? "A";

    return (
      <section className="rounded-2xl border border-gray-4 bg-gray-1 p-6 shadow-sm">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl border border-gray-4 bg-white">
                {definition.image ? (
                  <img
                    src={definition.image}
                    alt={`${definition.displayName} logo`}
                    className="h-full w-full object-contain p-2"
                    loading="lazy"
                  />
                ) : (
                  <span className="text-xl font-semibold text-gray-12">{appInitial}</span>
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-semibold leading-tight text-gray-12">
                    {layout.title}
                  </h2>
                  <AppStatusBadge status={layout.status} />
                </div>
                {layout.description && (
                  <p className="text-sm text-gray-11">{layout.description}</p>
                )}
                {layout.lastCheckedLabel && (
                  <p className="text-xs text-gray-9">
                    Last checked {layout.lastCheckedLabel}
                  </p>
                )}
              </div>
            </div>
          </div>
          {layout.onClose && (
            <Button variant="white" size="sm" onClick={layout.onClose}>
              Close
            </Button>
          )}
        </header>

        <div
          className={
            hasSide
              ? "mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]"
              : "mt-6 flex flex-col gap-6"
          }
        >
          <div className="flex flex-col gap-6">
            {layout.sections}
            {layout.actions && (
              <div className="flex flex-wrap items-center gap-3">
                {layout.actions}
              </div>
            )}
            {layout.summary && (
              <div className="rounded-xl border border-gray-4 bg-gray-2 p-4 text-sm text-gray-11">
                {layout.summary}
              </div>
            )}
          </div>
          {layout.side && (
            <aside className="flex flex-col gap-4 text-sm text-gray-11">
              {layout.side}
            </aside>
          )}
        </div>
      </section>
    );
  };

  return ManagementPanel;
};

const ManagementPanelSection = ({
  title,
  description,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-2">
    {title && <h3 className="text-sm font-medium text-gray-12">{title}</h3>}
    {description && <p className="text-xs text-gray-10">{description}</p>}
    {children}
  </section>
);

export { createManagementPanel, ManagementPanelSection };
