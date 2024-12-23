import 'server-only';
import fs from "fs";
import path from "path";
import { cache } from "react";

export const getMDXContent = cache(async (directory: string) => {
  const dir = path.join(process.cwd(), directory);
  const files = fs.readdirSync(dir).filter((file) => path.extname(file) === ".mdx");

  const posts = await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(dir, file);
      const fileContents = fs.readFileSync(filePath, "utf-8");
      const slug = path.basename(file, path.extname(file));
      return {
        slug,
        content: fileContents,
      };
    })
  );

  return posts;
}); 