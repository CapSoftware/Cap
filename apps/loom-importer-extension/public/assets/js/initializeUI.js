(async () => {
  const app = document.createElement("div");
  app.id = "root";
  document.body.append(app);

  const src = chrome?.runtime?.getURL("/react/main.js");
  await import(src);
})();
