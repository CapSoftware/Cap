import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import api from "./api";
import type MessageResponse from "./interfaces/MessageResponse";
import * as middlewares from "./middlewares";

require("dotenv").config();

const app = express();

app.use(morgan("dev"));
app.use(helmet());
app.use(cors());
app.use(express.json());

app.get<{}, MessageResponse>("/", (req, res) => {
	res.json({
		message: "OK",
	});
});

app.use("/api/v1", api);
app.use(middlewares.notFound);
app.use(middlewares.errorHandler);

export default app;
