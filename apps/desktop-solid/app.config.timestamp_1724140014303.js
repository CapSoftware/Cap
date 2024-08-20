// app.config.ts
import { defineConfig } from "@solidjs/start/config";
import { fileURLToPath } from "node:url";
import AutoImport from "unplugin-auto-import/vite";
import IconsResolver from "unplugin-icons/resolver";
import Icons from "unplugin-icons/vite";
var app_config_default = defineConfig({
  ssr: false,
  server: { preset: "static" },
  // https://vitejs.dev/config
  vite: () => ({
    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    // 1. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      watch: {
        // 2. tell vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"]
      }
    },
    // 3. to make use of `TAURI_DEBUG` and other env variables
    // https://tauri.studio/v1/api/config#buildconfig.beforedevcommand
    envPrefix: ["VITE_", "TAURI_"],
    plugins: [
      VinxiAutoImport({
        resolvers: [IconsResolver({ prefix: "Icon", extension: "jsx" })],
        dts: fileURLToPath(new URL("./src/auto-imports.d.ts", import.meta.url))
      }),
      Icons({ compiler: "solid" })
    ]
  })
});
var VinxiAutoImport = (options) => {
  const autoimport = AutoImport(options);
  return {
    ...autoimport,
    transform(src, id) {
      let pathname = id;
      if (id.startsWith("/")) {
        pathname = new URL(`file://${id}`).pathname;
      }
      return autoimport.transform(src, pathname);
    }
  };
};
export {
  app_config_default as default
};
