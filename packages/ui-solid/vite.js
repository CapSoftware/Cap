import { fileURLToPath } from "node:url";
import AutoImport from "unplugin-auto-import/vite";
import IconsResolver from "unplugin-icons/resolver";
import Icons from "unplugin-icons/vite";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import Unfonts from "unplugin-fonts/vite";

export default [
  VinxiAutoImport({
    resolvers: [
      IconsResolver({
        prefix: "Icon",
        extension: "jsx",
        customCollections: ["cap"],
      }),
    ],
    dts: fileURLToPath(new URL("./src/auto-imports.d.ts", import.meta.url)),
  }),
  Icons({
    compiler: "solid",
    enabledCollections: ["lucide"],
    customCollections: {
      cap: FileSystemIconLoader(
        fileURLToPath(new URL("./icons", import.meta.url))
        // (svg) => svg.replace(/^<svg /, '<svg stroke="currentColor" ')
      ),
    },
  }),
  Unfonts({
    fontsource: {
      families: [{ name: "Geist Sans", weights: [500, 700] }],
    },
  }),
];

// Workaround for https://github.com/solidjs/solid-start/issues/1374
function VinxiAutoImport(options) {
  const autoimport = AutoImport(options);

  return {
    ...autoimport,
    transform(src, id) {
      let pathname = id;

      if (id.startsWith("/")) {
        pathname = new URL(`file://${id}`).pathname;
      }

      return autoimport.transform(src, pathname);
    },
  };
}
