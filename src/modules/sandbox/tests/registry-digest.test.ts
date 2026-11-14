import { expect, test } from "bun:test";
import { prepareRegistryPull, usesAzureAuth } from "../registry-digest";

test("azure auth is detected by host and can be overridden per profile", () => {
  const reference = "exampleacr.azurecr.io/app:latest";

  expect(usesAzureAuth(reference)).toBe(true);
  expect(usesAzureAuth(reference, "docker")).toBe(false);
  expect(usesAzureAuth("registry.example.com/app:latest", "azure")).toBe(true);
  expect(usesAzureAuth("example/app:latest")).toBe(false);
});

test("pull preparation logs in through az only for Azure registries", async () => {
  const calls: string[][] = [];
  const runAz = async (args: string[]) => {
    calls.push(args);

    return "";
  };

  await prepareRegistryPull("example/app:latest", "auto", runAz);
  await prepareRegistryPull("exampleacr.azurecr.io/app:latest", "docker", runAz);
  await prepareRegistryPull("exampleacr.azurecr.io/app:latest", "auto", runAz);

  expect(calls).toEqual([["acr", "login", "--name", "exampleacr", "--only-show-errors"]]);
});
