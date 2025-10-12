import Link from "next/link";
import type { ReactNode } from "react";

import { Card } from "@cap/ui";

import type { SerializableAppDefinition } from "../../apps/types";
import type { AppMediaAsset } from "./server";

type AppPageLayoutProps = {
  readonly definition: SerializableAppDefinition;
  readonly gallery: ReadonlyArray<AppMediaAsset>;
  readonly children: ReactNode;
};

const Gallery = ({
  definition,
  gallery,
}: {
  definition: SerializableAppDefinition;
  gallery: ReadonlyArray<AppMediaAsset>;
}) => {
  if (gallery.length === 0) {
    return (
      <Card className="flex h-full min-h-[320px] items-center justify-center border-dashed border-gray-4 bg-gray-1 p-6 text-sm text-gray-9">
        <p className="text-center leading-relaxed">
          Add screenshots to
          <span className="mx-1 font-medium text-gray-12">
            packages/apps/src/{definition.slug}/media
          </span>
          to showcase this app.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {gallery.map((asset, index) => (
        <figure
          key={asset.filename}
          className="overflow-hidden rounded-3xl border border-gray-3 bg-gray-1 shadow-sm"
        >
          {/* biome-ignore lint/performance/noImgElement: data URLs generated at runtime are not compatible with next/image here */}
          <img
            src={asset.src}
            alt={`${definition.displayName} screenshot ${index + 1}`}
            className="h-auto w-full"
            loading={index === 0 ? "eager" : "lazy"}
          />
        </figure>
      ))}
    </div>
  );
};

export const AppPageLayout = ({
  definition,
  gallery,
  children,
}: AppPageLayoutProps) => (
  <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 py-6">
    <div className="flex items-center justify-between">
      <Link
        href="/dashboard/apps"
        className="text-sm font-medium text-gray-11 transition-colors hover:text-gray-12"
      >
        Back to apps
      </Link>
    </div>
    <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Gallery definition={definition} gallery={gallery} />
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  </div>
);
