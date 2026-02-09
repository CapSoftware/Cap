import { executeDeepLink } from "./utils";

export default async function OpenSettings() {
  await executeDeepLink(
    {
      open_settings: {
        page: null,
      },
    },
    "Opening Cap settings",
  );
}
