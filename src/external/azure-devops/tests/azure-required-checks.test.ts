import { expect, mock, test } from "bun:test";
import { PolicyEvaluationStatus } from "azure-devops-node-api/interfaces/PolicyInterfaces";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import { azureProvider } from "./support/azure";
import type { AzureGitClient } from "../provider";

const ref: PullRequestRef = {
  provider: "azure-devops",
  organizationUrl: "https://dev.azure.com/acme",
  id: 42,
};

test("Azure required checks include only enabled blocking build and status evaluations", async () => {
  const getPullRequestStatuses = mock<AzureGitClient["getPullRequestStatuses"]>(async () => []);
  const provider = azureProvider(
    { getPullRequestStatuses },
    {
      getPolicyEvaluations: async () => [
        {
          evaluationId: "required-build",
          status: PolicyEvaluationStatus.Running,
          configuration: {
            isBlocking: true,
            isEnabled: true,
            type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
            settings: {},
          },
        },
        {
          evaluationId: "required-status",
          status: PolicyEvaluationStatus.Approved,
          configuration: {
            isBlocking: true,
            isEnabled: true,
            type: { id: "c2a1889d-b943-4856-b76f-9e46bb6b0df2" },
            settings: { statusName: "Security" },
          },
        },
        {
          evaluationId: "optional-build",
          configuration: {
            isBlocking: false,
            isEnabled: true,
            type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
            settings: {},
          },
        },
        {
          evaluationId: "disabled-build",
          configuration: {
            isBlocking: true,
            isEnabled: false,
            type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
            settings: {},
          },
        },
        {
          evaluationId: "reviewer-policy",
          configuration: {
            isBlocking: true,
            isEnabled: true,
            type: { id: "reviewer-policy" },
            settings: {},
          },
        },
      ],
    },
  );

  const requiredChecks = await provider.getChecks(ref, { requiredOnly: true });

  expect(requiredChecks).toEqual([
    { id: "build:required-build", name: "Build validation", state: "running" },
    { id: "policy:required-status", name: "Security", state: "passed" },
  ]);
  expect(getPullRequestStatuses).not.toHaveBeenCalled();
});
