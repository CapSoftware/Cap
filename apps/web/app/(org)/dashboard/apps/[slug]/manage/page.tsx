import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";

import { AppPageLayout } from "../AppPageLayout";
import {
  fetchDefinition,
  loadAppMediaAssets,
  loadAppSpaces,
  requireActiveOrganizationOwner,
} from "../server";

import { AppManageClient } from "./AppManageClient";

type PageParams = {
  slug: string;
};

type PageProps = {
  params: Promise<PageParams>;
};

export async function generateMetadata(
  props: PageProps
): Promise<Metadata | undefined> {
  const params = await props.params;
  const definition = await fetchDefinition(params.slug);

  if (!definition) {
    return undefined;
  }

  return {
    title: `Manage ${definition.displayName} — Cap Apps`,
    description: `Configure ${definition.displayName} for your workspace.`,
  };
}

export default async function ManageAppPage(props: PageProps) {
  const params = await props.params;

  const { organizationId } = await requireActiveOrganizationOwner();

  const definition = await fetchDefinition(params.slug);

  if (!definition) {
    notFound();
  }

  const spaces = await loadAppSpaces(organizationId);
  const gallery = await loadAppMediaAssets(definition.slug);

  return (
    <AppPageLayout definition={definition} gallery={gallery}>
      <AppManageClient definition={definition} spaces={spaces} />
      <div className="rounded-2xl border border-gray-3 bg-gray-1 p-6">
        {definition.content && definition.content.trim().length > 0 ? (
          <article className="prose max-w-none prose-headings:font-semibold">
            <MDXRemote source={definition.content} />
          </article>
        ) : (
          <p className="text-sm text-gray-10">
            We&apos;re putting the finishing touches on this guide. Check back
            soon.
          </p>
        )}
      </div>
    </AppPageLayout>
  );
}
