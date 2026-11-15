import { Hono } from "hono";
import { upgradeWebSocket } from "@hono/node-server";
import { externalControlGate, wsGate } from "./gate";
import { createRequestGate } from "./requestGate";
import { buildRoutes } from "./routes";
import { wsHandlers } from "./ws";

/** HTTP 和 WS 升级共用来源门禁，必须在注册业务路由前执行。 */
export const buildServerApp = (allowLan: boolean): Hono => {
  const app = new Hono();
  app.use("*", createRequestGate(allowLan));
  app.use("/api/*", externalControlGate);
  app.route("/api", buildRoutes());
  app.get(
    "/ws",
    externalControlGate,
    wsGate,
    upgradeWebSocket(() => wsHandlers),
  );
  app.get("/", (c) => c.text("SPlayer Next external API"));
  return app;
};
