// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";

export default createHandler(() => (
  <StartServer
    document={({ assets, children, scripts }) => (
      <html lang="en" class="overflow-hidden h-full">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <link rel="icon" type="image/svg+xml" href="/assets/logo.svg" />
          <script
            src="https://cdn.usefathom.com/script.js"
            data-spa="auto"
            data-site="IYNNVDNT"
            defer
          ></script>
          {assets}
        </head>
        <body class="w-full h-full select-none cursor-default">
          <div id="app" class="h-full">
            {children}
          </div>
          {scripts}
        </body>
      </html>
    )}
  />
));
