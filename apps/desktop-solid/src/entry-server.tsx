// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";

export default createHandler(() => (
  <StartServer
    document={({ assets, children, scripts }) => (
      <html lang="en" class="overflow-hidden">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <link rel="icon" type="image/svg+xml" href="/assets/logo.svg" />
          {assets}
        </head>
        <body class="w-full h-full">
          <div id="app">{children}</div>
          {scripts}
        </body>
      </html>
    )}
  />
));
