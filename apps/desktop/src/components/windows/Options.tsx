import { FloatingOptions } from "@/components/FloatingOptions";
import { setWindowPosition } from "@/utils/helpers";

export const Options = () => {
  setWindowPosition("bottom_center");

  return <FloatingOptions />;
};
