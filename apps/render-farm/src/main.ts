export {};

const role = process.env.RF_ROLE ?? "worker";
if (role === "coordinator") await import("./coordinator");
else if (role === "worker") await import("./worker");
else throw new Error(`unknown RF_ROLE ${role}`);
