import { test, expect, request } from "@playwright/test";

test.describe("GET /api/v1", () => {
  let apiContext:any;

  test.beforeAll(async ({ playwright }) => {
    apiContext = await playwright.request.newContext({
      baseURL: "http://localhost:3002",
    });
  });

  test.afterAll(async () => {
    await apiContext.dispose();
  });

  test("responds with a json message", async () => {
    const response = await apiContext.get("/api/v1", {
      headers: {
        Accept: "application/json",
      },
    });

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");

    const responseBody = await response.json();
    expect(responseBody).toEqual({ message: "OK" });
  });
});
