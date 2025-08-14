import app from "./app";

const port = Number(process.env.PORT) || 3002;

app.listen(port, "0.0.0.0", () => {
	console.log(`Listening: http://localhost:${port}`);
});
