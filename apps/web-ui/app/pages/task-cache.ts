import type { IssueGroup } from "../components/issue/issue";

const projects = new Map<string, IssueGroup[]>();

export function cachedTaskGroups(project: string) {
  return projects.get(project);
}

export function cacheTaskGroups(project: string, groups: IssueGroup[]) {
  projects.delete(project);
  projects.set(project, groups);
  if (projects.size > 20) projects.delete(projects.keys().next().value!);
}
