---
name: horizon
description: Finds a way through an existing Beads backlog as a shared horizon of tasks, distinguishing full-send work from grilling, research, and prototypes. Use when choosing the next batch of work, planning progress toward an epic, or working through an existing backlog.
---

The backlog already exists, too big for one agent session: the way through it isn't visible yet. Wayfinding is about finding that way, not charging through whichever ticket comes first. This skill reads the **shared map** in Beads, then chooses a **horizon** of existing tasks to work through one at a time.

The destination varies per session: progress toward an epic, clearing a particular area, or finding useful work across the backlog. It shapes which tickets belong in the horizon, without redefining the rest of the project.

## Plan, then work

Horizon is **planning** by default: choose the next batch and make clear how each ticket should be worked. When the user asks to work through it, carry execution through the horizon. Some tickets resolve decisions; others deliver changes. Planning the batch does not itself start implementation.

## Refer by name

Every epic and ticket has a **name**: its title. In everything the human reads, refer to it by that name, never by a bare id, number, or slug. A wall of `eden-3.3, eden-4yh, eden-sbi` is illegible; names read at a glance. The id and URL don't vanish; a name wraps its link where available, but they ride alongside the name, never stand in for it.

## The Map

The map is the existing backlog in Beads: epics, tickets, and their native dependencies.

The horizon is an **index**, not a store. It selects the next tickets and points at the detail they already hold. Keep their existing parents; a place in the horizon is not a new dependency.

Keep the horizon in the conversation by default. When a durable resume point is useful, record a short note on the relevant existing epic. Decisions and implementation evidence remain on the tickets they concern.

### Read the map

Start with compact summaries, then zoom into selected tickets:

```sh
bd list --type epic --brief --json --sort priority --limit 20
bd list --status open,in_progress,blocked --brief --json --sort priority --limit 30
bd ready --brief --json --sort priority --limit 20
bd show <id> --json
```

For a particular epic or candidate:

```sh
bd list --parent <epic-id> --brief --json --sort priority --limit 30
bd ready --parent <epic-id> --brief --json --sort priority --limit 20
bd dep tree <id> --direction down --max-depth 3
bd dep tree <id> --direction up --max-depth 3
```

`list --parent` shows direct children; inspect nested parents as needed. `ready --parent` finds ready descendants. Dependency trees show what blocks a candidate (`down`) and what it unlocks (`up`). Consult the installed command's help when an invocation is unavailable.

Priority is a starting order, not the whole selection policy. Follow real prerequisites, favor work that unlocks the current destination, and keep independent full-send work available alongside useful grilling. Broaden bounded queries when needed; the first page is not the backlog.

### Tickets

Each ticket's Beads id is its identity. Inspect current code and selected ticket notes before treating an old specification as the implementation contract. Reconcile stale or already completed work before putting it in the horizon.

Classify each selected ticket as `research`, `prototype`, `grilling`, `task`, or `full-send` in the horizon. These describe the next action, not the ticket's Beads issue type. Blocking describes when it can be taken.

Blocking uses Beads' **native** dependency relationship. The **frontier** is the open, unblocked, unclaimed work toward the destination, the edge of the known. Beads readiness does not prove that a ticket's product decisions are settled. Inspect current ownership before claiming a ticket, and mark it in progress when work starts, so concurrent sessions skip it.

## Ticket Types

Every next action is either **HITL** (human in the loop, worked _with_ a human who speaks for themselves) or **AFK**, driven by the agent alone. A HITL action only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Reading documentation, third-party APIs, code, or local resources like knowledge bases to surface a fact a task waits on. State the question and evidence needed. Use the available research tools or skill; delegate when authorized. Resolved when the evidence answers the question or establishes what remains unknown.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to (an outline, a rough take, a stub, or UI/logic code). Links the prototype as an asset. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation. Use `grill-me`: ask one question at a time, with a recommendation. Explore code-answerable questions yourself. Keep the grilling light when the boundary needs only a small clarification; go deeper when the decision warrants it.
- **Task** (HITL or AFK): Manual work that must happen before a ticket can proceed: nothing to decide, prototype, or research, but progress is blocked until it's done. Signing up for a service, provisioning access, moving data so its shape can be seen. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; record the resulting facts later work depends on.
- **Full-send** (AFK): Implementation whose observable behavior, scope, and acceptance criteria are clear enough for the agent to carry through without choosing product behavior for the human. Resolved when the work is implemented and verified, not merely when its design is settled. If a consequential choice surfaces, return it to grilling.

## Horizon

Chart an adaptive batch ahead, usually around 5–15 tickets: more when work is small, independent, and well understood; fewer when decisions could reshape what follows. Honor an explicit count, but never split work or invent certainty to fill it. Explain the chosen horizon briefly.

Specify the nearest work carefully; leave what cannot yet be specified as brief unresolved questions. Include decisions that unlock the destination alongside full-send work that can proceed independently. When a decision changes the route, refresh the affected tickets and horizon. Completing a batch does not authorize endlessly replenishing it.

## Fog of war

The horizon is _deliberately_ incomplete: don't chart what you can't yet see. Even an existing ticket can be wrapped in **fog of war**: an unclear acceptance criterion, a stale assumption, or a choice whose answer changes the implementation. Name that uncertainty rather than assuming the ticket is ready because it already exists.

Keep small clarifications on the existing ticket. Propose a separate decision or research ticket when its answer needs independent tracking or unlocks several tasks. Resolving the question clears the fog ahead of it; update the affected tickets and their next actions. Settling a question does not close an unimplemented feature.

## Out of scope

The destination fixes the scope of this horizon. Work beyond it stays in the backlog. Skipping a ticket removes it from the current batch; it does not close it, defer it project-wide, or rule it out of a future horizon.

## Invocation

Two modes. Finding the route prepares the batch. Working through it carries out the user's authorized work, sequentially unless requested otherwise. If requested, lightly grill each ticket first. While authorized implementation runs, the next independent grilling conversation can happen here.

### Find the route

User invokes with a backlog, epic, area of interest, or request for the next batch.

1. **Name the destination.** Infer the focus and exclusions from the request; clarify only where the choice would materially change the batch.
2. **Read the map.** Inspect existing epics, ready work, and relevant blockers. Check selected ticket notes against current code.
3. **Choose the horizon.** Select an adaptive batch of existing tickets, with their next action, blockers, and a brief reason for the order.
4. **Expose the uncertainty.** Identify the questions that prevent selected tasks from being full-send. Keep small clarifications on their existing tickets; propose new tickets only for genuinely missing work.
5. **Present the route.** Make clear what can proceed autonomously and what needs the user's next contribution. Record a resume note on the relevant epic when useful.

### Work through the horizon

User invokes with a horizon or asks to continue. A ticket is **optional**: without one, you pick the next ticket, not the user.

1. Load the **horizon** and current Beads summaries: the low-res view, not every ticket body. Reconcile completed work, changed scope, and current blockers.
2. Choose the ticket. If the user named one, use it. Otherwise take the first frontier ticket in horizon order. **Claim it** using the project's assignment convention and mark it in progress before starting work.
3. Work it as the next action calls for (see [Ticket Types](#ticket-types)). **Zoom as needed**: fetch the full body of any related or closed ticket on demand; consult relevant project skills. If in doubt about a consequential choice, use `grill-me`.
4. Record the result on the ticket: the decision, evidence, asset pointer, or implementation and verification. **Close** the ticket only when its own acceptance criteria are met; otherwise update its next action and remaining scope.
5. Refresh the affected horizon and tickets. Continue through the authorized batch; if a ticket is waiting on the user, another independent ticket may proceed. End with completed outcomes, unresolved questions, and the next resume point.

Carry the user's commit and publishing instructions through the session; prefer sensible task-sized commits when authorized. The user may run unblocked tickets in parallel, so expect other sessions to be editing the tracker concurrently.
