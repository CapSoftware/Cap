import { executeCapAction } from "./utils";

export default async function Command() {
  await executeCapAction("screenshot");
}
