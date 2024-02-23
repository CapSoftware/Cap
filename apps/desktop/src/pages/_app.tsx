import { Providers } from "@/providers";
import "@/styles/globals.css";
import type { AppProps } from "next/app";

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <Providers>
      <Component {...pageProps} />
    </Providers>
  );
}

export default MyApp;
