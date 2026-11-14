import { expect, test } from "bun:test";
import { usesAzureAuth } from "../registry-digest";

test("azure auth is detected by host and can be overridden per profile", () => {
  const reference = "exampleacr.azurecr.io/app:latest";

  expect(usesAzureAuth(reference)).toBe(true);
  expect(usesAzureAuth(reference, "docker")).toBe(false);
  expect(usesAzureAuth("registry.example.com/app:latest", "azure")).toBe(true);
  expect(usesAzureAuth("example/app:latest")).toBe(false);
});
