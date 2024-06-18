import app from "./app";

const port = process.env.TASKS_APP_PORT || 3002;
app.listen(port, () => {
  console.log(`Listening: http://localhost:${port}`);
});
