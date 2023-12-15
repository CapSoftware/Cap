"use client";
import { Button } from "ui";
import type { Database } from "@/utils/database/supabase/types";
import { Eye, FileText, Lock } from "lucide-react";

export const Caps = ({
  data,
}: {
  data: Database["public"]["Tables"]["videos"]["Row"][] | null;
}) => {
  return (
    <div className="py-12">
      {data?.length === 0 ? (
        <div className="min-h-full h-full flex flex-col items-center justify-center">
          <div className="w-full max-w-md mx-auto">
            <img
              className="w-full h-auto"
              src="/illustrations/person-microphone.svg"
              alt="Person using microphone"
            />
          </div>
          <div className="text-center">
            <h2 className="text-2xl font-semibold mb-3">
              Record your first cap.
            </h2>
            <p className="text-xl max-w-md">
              Craft your narrative with a Cap—get projects done quicker.
            </p>
            <Button size="lg" className="mt-8" variant="default">
              Record a Cap
            </Button>
          </div>
        </div>
      ) : (
        <div className="border-subtle bg-default mb-16 rounded-lg border bg-white subtle-shadow">
          <ul
            className="divide-subtle divide-y"
            style={{ position: "relative" }}
          >
            {data?.map((cap, index) => {
              return <li key={index}>{cap.name}</li>;
            })}
          </ul>
        </div>
      )}
    </div>
  );
};
