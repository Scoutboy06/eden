import { expect, mock, test } from "bun:test";
import { openBrowser } from "../browser";

test.each([
  ["linux", ["xdg-open"]],
  ["darwin", ["open"]],
  ["win32", ["rundll32.exe", "url.dll,FileProtocolHandler"]],
] as const)("browser launcher uses argument arrays on %s", async (platform, prefix) => {
  const launch = mock(async () => 0);
  const url = "https://dev.azure.com/acme/My%20Project/_git/app/pullrequest/42";

  await openBrowser(url, platform, launch);

  expect(launch).toHaveBeenCalledWith([...prefix, url]);
});

test.each([false, true])("browser launcher normalizes failures (throws: %s)", async (throws) => {
  const launch = async () => {
    if (throws) throw new Error("ENOENT");

    return 1;
  };

  await expect(
    openBrowser("https://github.com/acme/app/pull/12", "linux", launch),
  ).rejects.toMatchObject({
    code: "SCM_BROWSER_FAILED",
    message: expect.stringContaining("--print-url"),
  });
});
