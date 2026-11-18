# Herdr workflow smoke test

- Bead: `eden-umj`
- Worktree branch: `task/eden-umj-herdr-smoke`
- Review: draft PR only; do not merge.

This snippet gives the draft a small, runnable change without changing Eden's runtime:

```js
const task = "eden-umj";
const branch = `task/${task}-herdr-smoke`;

if (!branch.startsWith(`task/${task}-`)) throw new Error("Task ID missing from branch");
console.log(branch);
```

In Herdr, open the task on Board, follow its worktree to Doing, and open PRs to read the draft's discussion.
