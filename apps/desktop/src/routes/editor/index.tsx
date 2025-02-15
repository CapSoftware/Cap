import { Suspense } from "solid-js";
import { Editor } from "./Editor";
import { AbsoluteInsetLoader } from "~/components/Loader";

export default function () {
  return (
    <Suspense fallback={<AbsoluteInsetLoader />}>
      <Editor />
    </Suspense>
  );
}
