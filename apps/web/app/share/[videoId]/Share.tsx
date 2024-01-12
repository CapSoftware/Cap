"use client";
import { Button } from "@cap/ui";
import type { Database } from "@cap/utils";
import { classNames } from "../../../../../packages/ui/src/utils/helpers";

export const Share = ({
  data,
}: {
  data: Database["public"]["Tables"]["videos"]["Row"] | null;
}) => {
  return (
    <div className="wrapper py-24">
      <h1 className="text-2xl mb-3 text-center">
        My Video: 2024-01-12 17:32:54
      </h1>
      <div className="w-full max-w-[500px] h-96 mx-auto bg-gray-100 rounded-xl"></div>
    </div>
  );
};
