"use client";

import {
  type AppDefinitionType,
  type AppInstallationViewType,
  type AppSelection,
  type AppSpace,
  AppsUiProvider,
  getAppManagementComponent,
} from "@cap/apps/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Effect, Option } from "effect";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { SerializableAppDefinition } from "../../../apps/types";
import { useEffectMutation, useEffectQuery } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";

type AppManageClientProps = {
  definition: SerializableAppDefinition;
  spaces: AppSpace[];
};

const toastApi = {
  success: toast.success,
  error: toast.error,
};

const AppManageClient = ({ definition, spaces }: AppManageClientProps) => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const definitionValue = useMemo(
    () => definition as unknown as AppDefinitionType,
    [definition]
  );

  const installationQuery = useEffectQuery<
    AppInstallationViewType | null,
    unknown,
    true
  >({
    throwOnDefect: true,
    queryKey: ["apps", "installation", definitionValue.slug],
    queryFn: () =>
      withRpc((rpc) =>
        rpc
          .AppsGetInstallation({ slug: definitionValue.slug })
          .pipe(Effect.map((installation) => Option.getOrNull(installation)))
      ),
    staleTime: 30_000,
    refetchOnWindowFocus: "always",
    refetchOnMount: "always",
  });

  const installation = installationQuery.data ?? null;

  const selection = useMemo<AppSelection>(
    () => ({ definition: definitionValue, installation }),
    [definitionValue, installation]
  );

  const ManagementComponent = useMemo(
    () => getAppManagementComponent(definitionValue.slug),
    [definitionValue.slug]
  );

  const handleSelectionChange = (next: AppSelection | null) => {
    const updatedInstallation = next ? next.installation : null;
    queryClient.setQueryData<AppInstallationViewType | null>(
      ["apps", "installation", definitionValue.slug],
      updatedInstallation
    );
  };

  const uiDependencies = useMemo(
    () => ({
      useEffectQuery,
      useEffectMutation,
      withRpc,
      useQueryClient,
      toast: toastApi,
    }),
    []
  );

  if (!ManagementComponent) {
    return (
      <div className="rounded-xl border border-gray-4 bg-gray-2 p-6 text-sm text-gray-10">
        Management isn&apos;t available for this app yet.
      </div>
    );
  }

  return (
    <AppsUiProvider value={uiDependencies}>
      <ManagementComponent
        selection={selection}
        spaces={spaces}
        onClose={() => router.push("/dashboard/apps")}
        onSelectionChange={handleSelectionChange}
      />
    </AppsUiProvider>
  );
};

export { AppManageClient };
