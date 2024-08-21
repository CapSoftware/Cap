import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import capUIPlugin from "@cap/ui-solid/vite";

export default defineConfig({
  plugins: [solid(), capUIPlugin],
});
