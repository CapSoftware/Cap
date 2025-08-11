import { createContextProvider } from "@solid-primitives/context";
import { createOptionsQuery } from "~/utils/queries";

const [RecordingOptionsProvider, useRecordingOptionsContext] =
  createContextProvider(() => {
    return createOptionsQuery();
  });

export function useRecordingOptions() {
  return (
    useRecordingOptionsContext() ??
    (() => {
      throw new Error("useOptions must be used within an OptionsProvider");
    })()
  );
}

export { RecordingOptionsProvider };
