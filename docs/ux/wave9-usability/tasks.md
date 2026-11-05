# Round 3 usability test: tasks

AFD-99. Round 3 tests the wave 9 build (0.64.1) with a person, as rounds 1 and 2 tested wave 8
(`../wave8-usability/`). The method, measures, severity scale and privacy rules are the same
(`../wave8-usability/protocol.md`); this page says what changes and lists the tasks. The kit
runs it as variant C; the walkthrough is `walkthrough-r3.md`.

## What changes from round 2

- **Twice as long.** Round 2's tasks took 36 minutes in all (48 with the break and the
  questionnaires). Round 3 has 16 tasks, about 55-60 minutes of task time for a person who knows
  the designer, in four parts with two breaks: about 90 minutes in all.
- **Half the tasks change parameters and settings** (T2-T9): optional parameters, changing and
  clearing a value, data from one step to the next, an input given at run time with its
  description, retries, one host at a time, another user and hidden output, a loop. Rounds 1 and 2
  had one such task (T2, bind a step).
- **Every wave 9 change has a task** (table at the end). Round 2's failed or partial tasks come
  back in the same shape (T7 → T13, T8 → T12, T9 → T15, T11 → T16), so the rounds compare.
- **Some old tasks stay, shortened:** a failure path (T1), a check run (T10), a real run with
  inputs (T11). The first flow (round 2's T1, 1.6 minutes) and the layout task (T10, 30 seconds)
  are dropped.
- **Variant C:** a new set of names (firewalls instead of switches and routers), so no answer
  comes from memory. Hosts are in two inventory groups under `lab`, so a run must choose one.
- **Round 2's kit fixes:**
  - a card's text before Start says what to prepare (T16: save and close the designer tabs);
  - the scenario check takes an end by key or by title (T12);
  - T16 makes the change while the flow is closed, which wave 9 now marks.

## Parts and timing

| Part | Tasks   | Theme                | Expected minutes | Limits (sum) |
| ---- | ------- | -------------------- | ---------------- | ------------ |
| 1    | T1-T4   | Change a flow        | 11               | 20           |
| 2    | T5-T9   | Settings and inputs  | 18               | 27           |
| 3    | T10-T12 | Run and test         | 11               | 19           |
| 4    | T13-T16 | Review the workspace | 13               | 21           |

Expected minutes are round 2's times for tasks of the same shape, and estimates for the new ones.
Take a break after part 2. A shorter one after part 1 or 3 is fine: the clock runs only inside a
task.

## The cards

As before, a card says what to achieve, never which control to use; the goal shows on Start, and
the check is what the verifier looks at. **Probes** names what the task tests: a wave 9 change
(the round 2 finding it fixed, `../wave8-usability/round2.md`) or an older feature.

### Part 1: change a flow

| Task | Card                                                                                                                                                                                                                                                     | Limit | Check                                                                                                           | Probes                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| T1   | In "Firewall baseline", add a step "Check management access" between "Check the firewall answers" and "Write the login banner". Firewalls that fail it must not continue: they end the flow as stopped. Save the flow.                                   | 4     | start → Check the firewall answers → the new step → Write the login banner; its failed hosts reach a failed end | palette after the selected step (W1), Stop Flow in the banner (W5), port hover (S1) |
| T2   | In "Firewall baseline", make "Write the login banner" use `ansible.builtin.copy` to write the text "Managed by SecOps" into `/etc/issue.net`, owned by root, with file mode 0644. Save the flow.                                                         | 6     | copy with `content`, `dest`, `owner` and `mode` as asked (only `dest` is required)                              | Configure, parameter search                                                         |
| T3   | In "Rule set deploy", "Push the rule set" leaves the rule file readable by everyone and keeps a backup copy of the old one. Make the file readable by its owner only (mode 0600) and stop keeping backups. Leave its other parameters as they are. Save. | 4     | `mode` 0600; `backup` gone or false; `src` and `dest` as they were                                              | changing and clearing a value                                                       |
| T4   | In "Rule set deploy", "Report the version" always prints "unknown". Make it print the version that "Read the software version" read (its standard output). Save.                                                                                         | 6     | Report the version has an input from Read the software version, and its message uses it                         | data between steps (outputs, the @ picker)                                          |

### Part 2: settings and inputs

| Task | Card                                                                                                                                                                                                                | Limit | Check                                                                                                       | Probes                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| T5   | In "Config backup", "Upload to the archive" always uploads to archive-01.lab.example. Make the archive server a value that whoever runs the flow must give, explained as "Archive server to upload to". Save.       | 7     | a required flow input with that description; the step's `url` reads it through an input from the flow input | input descriptions (W9), the inputs editor, @ picker |
| T6   | In "Rule set deploy", "Wait for the policy to install" checks only once. Make it keep checking, up to 10 times, 15 seconds apart, until its output says installed. Save.                                            | 5     | `retries` 10, `delay` 15, `until` reads the step's result and tests for "installed"                         | Timing settings; Until names the result variable     |
| T7   | In "Firewall upgrade", the subflow "Upgrade the software" upgrades every firewall at once. Make it upgrade one firewall at a time, each through all its steps before the next one starts. Save.                     | 4     | the subflow's `rolling` is 1                                                                                | rolling subflows                                     |
| T8   | In "Config backup", "Read the backup key" must run as the user svc-backup, not as root, and what it reads must never show in logs or run output. Save.                                                              | 5     | `become` on, the user svc-backup (setting or keyword), the task keyword `no_log: true`                      | Privilege settings, task keywords                    |
| T9   | In "Config backup", "Export the zone rules" exports the zone ZONE, which does not exist. Make it run once for each of the zones trust, untrust and dmz, with the zone's name in its command in place of ZONE. Save. | 6     | a `loop` (or `with_items`) of the three zones; the command reads the loop variable                          | task keywords, a parameter reading a loop variable   |

### Part 3: run and test

| Task | Card                                                                                                                                                                                                                                              | Limit | Check                                                                                                                    | Probes                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| T10  | Run "Firewall health check" as a check, so nothing changes, on the firewalls of the site lab-fw-35 belongs to, and only those. Some fail. **Answer:** which step failed for which firewall? Name every pair.                                      | 8     | a finished check run on the 3 hosts of `site_south`; the answer names lab-fw-35 (policy version) and lab-fw-36 (HA pair) | a group's hosts in the dialog (S2), no host list given (X5), Run Results (S3), Output (S4) |
| T11  | Change ticket CHG-3121 approves rule set edge-v42 for the window 22:00-23:00 UTC. Run "Rule rollout" for real on all lab firewalls with what the ticket says. The lab hosts are fictional and use the local connection: nothing reaches a device. | 6     | a real run on all 6 hosts, nothing failed; its output shows edge-v42, CHG-3121 and 22:00-23:00                           | input descriptions in the dialog (W9), Run in view (S6)                                    |
| T12  | "Firewall health check" has scenario tests. Run them. One fails. **Answer:** which firewall ended where, where was it expected to end, and why?                                                                                                   | 5     | the answer names lab-fw-36, Stopped and Reported to SecOps (by title or key), and the HA step                            | scenario results in words (S9)                                                             |

### Part 4: review the workspace

| Task | Card                                                                                                                                                                                                                                                                             | Limit | Check                                                                                                   | Probes                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| T13  | Get an overview of this workspace's flows, opening as few of them as you can. **Answer:** which flow has an error that stops it from generating code? Which flow's generated playbook was changed by hand?                                                                       | 5     | the answer names "VPN audit" and "Log archive rotation"                                                 | Problems for every flow, the playbook warning, the flow panel's line (S8)       |
| T14  | Someone fixed the generated playbook of "Log archive rotation" by hand: it now keeps archives for 30 days instead of 7. Keep that fix for good: make the flow do the same, so that generating its code again keeps 30 days and the playbook no longer counts as changed by hand. | 6     | the step's `age` is 30d; the playbook is the designer's, not edited by hand, and says 30d               | the playbook warning's Open the Flow, changing a value, overwriting code        |
| T15  | In "Firewall upgrade", use the Access lens: it shows who acts with which privileges. Two steps raise privileges unlike their neighbours. "Restart the log daemon" really needs root: keep it and record why. "Write the upgrade summary" does not need root: fix it. Save.       | 5     | the first keeps `become` with its lens finding accepted and a reason; the second has no `become`        | lens rows that stay put (S10, patched in 0.59.3), lighting (S11), the fold (X4) |
| T16  | **Before Start:** save all files and close the designer tabs. When you press Start, the kit commits your work so far, then brings in a colleague's change to "Firewall upgrade", as a Git pull would. Find out what the colleague changed. **Answer:** what did they change?     | 5     | the answer names the added step, the renamed step (old or new title) and the step whose binding changed | marks for changes made while the flow was closed, Git included (S12)            |

## What the workspace holds (variant C)

"Edge security automation", built with the repository's flow code as before, so every flow is
valid for the build under test and `generated/` comes from its engine. All names are fictional.

| Flow                  | Folder           | Used in      | Planted on purpose                                                                                                                                                                                             |
| --------------------- | ---------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firewall baseline     | `flows/security` | T1, T2       | Check the firewall answers → Write the login banner (unbound) → Save the configuration; a Stopped end                                                                                                          |
| Rule set deploy       | `flows/security` | T3, T4, T6   | Push the rule set (`copy`: `src`, `dest`, `mode: "0644"`, `backup: true`); Wait for the policy to install (`command`, no retries); Read the software version; Report the version (`debug`, "Version: unknown") |
| Config backup         | `flows/platform` | T5, T8, T9   | Read the backup key (`command`); Export the zone rules (`command`, `fwctl export --zone ZONE`); Upload to the archive (`uri`, the server in its `url`)                                                         |
| Firewall health check | `flows/security` | T10, T12     | Two asserts: policy version 42 or newer (fails lab-fw-33 and lab-fw-35), HA pair in sync (fails lab-fw-36); a scenario that expects the wrong end                                                              |
| Rule rollout          | `flows/security` | T11          | Three required inputs with short names and descriptions: `rs_tag` ("Rule set to install: its release tag, like edge-v40"), `mw` ("Maintenance window in UTC, HH:MM-HH:MM"), `chg` ("Approved change ticket")   |
| Firewall upgrade      | `flows/security` | T7, T15, T16 | 4 subflows, 2 approvals, 2 steps with `become` unlike their neighbours                                                                                                                                         |
| VPN audit             | `flows/security` | T13          | A wire to a port that does not exist (an error)                                                                                                                                                                |
| Log archive rotation  | `flows/platform` | T13, T14     | Find old archives (`find`, `age: 7d`); its generated playbook edited by hand to `30d`                                                                                                                          |
| Policy pipeline       | `flows/platform` | none         | Hand-placed steps and a section, so the workspace has a clean flow too                                                                                                                                         |

The inventory `inventory/lab.ini` has six firewalls in two groups, both children of `lab`, with
`ansible_connection=local`:

| Group        | Hosts                           | Planted                                                    |
| ------------ | ------------------------------- | ---------------------------------------------------------- |
| `site_north` | lab-fw-31, lab-fw-32, lab-fw-33 | lab-fw-33 runs policy version 40                           |
| `site_south` | lab-fw-34, lab-fw-35, lab-fw-36 | lab-fw-35 runs policy version 41; lab-fw-36 has no HA peer |

So a check run on all firewalls gives three failing pairs, one of them in the north; T10 asks for
the south only.

## Participant and session

- **P1 only**, as in rounds 1 and 2; there is no newcomer this round, so there is no first-flow
  warm-up (product owner's decision, 2026-11-05). P1's third session: the variant's names stop
  recall of answers, not of the product.
- **One sitting** of about 90 minutes, with the breaks between parts.

## Running it

The kit runs round 3 as variant C (`scripts/usability/round3/`). Its setup is that of rounds 1-2
(`../wave8-usability/protocol.md`), with 0.64.2, which fixes Y6 (below):

```bash
just usability-kit 3 c out/ansible-flow-designer-0.64.2.vsix
```

`just usability verify <session folder>` checks a session again; `just usability solve <session
folder>` is the kit's self-test.

What the kit does for round 3:

- **The runner** shows four parts with their titles and notes, and the intro's length. A card's
  text before Start says what to prepare (T16).
- **T16:** on Start, the kit:
  1. commits the workspace as it is ("Work so far", the fictional session author);
  2. applies the colleague's change through the flow tools and commits it as R. Ortiz;
  3. keeps in `session.json` when the designer last remembered the flow (`outsideFacts.shownAt`),
     so the analysis knows whether P1 saw the marks for a closed flow.
- **The checks:**
  - T10 and T11 read each run's events: which hosts ran, and the ticket's values (the audit never
    records inputs);
  - T14 reads the playbook's state with the engine's own `generatedState`;
  - T12 takes an end by key or by title;
  - an empty answer fails, and an answer the check cannot match goes to review.
- **The self-test** solves every file-checked task (T1-T9, T14, T15).

## Before the session

The walkthrough (`walkthrough-r3.md`) found Y6, a bug: an input's description was lost when the
designer or the flow tools wrote it. On 0.64.1, T5 fails whatever P1 does, and T11 shows no
descriptions. 0.64.2 fixes it (AFD-100), so the session runs on 0.64.2 or later.

- The inputs editor has no default value (Y5), so T5 asks for a required input.
- The other predictions (Y7-Y9) are for the session to confirm or not.

## Wave 9 coverage

| Wave 9 change (round 2 finding)                       | Task                                |
| ----------------------------------------------------- | ----------------------------------- |
| Marks for flows edited while closed (S12)             | T16                                 |
| Problems for every flow, the playbook warning (S8)    | T13, T14                            |
| The flow panel's workspace line (S8, X2)              | T13                                 |
| A filter's results in words (S7)                      | none: walkthrough only              |
| Scenario results in words (S9)                        | T12                                 |
| A group's hosts in the launch dialog (S2)             | T10                                 |
| No host list given when the inventory has groups (X5) | T10                                 |
| Run stays in view (S6)                                | T11                                 |
| Input descriptions (W9)                               | T5, T11                             |
| Run Results from a step's Details (S3)                | T10                                 |
| Output as an icon (S4)                                | T10                                 |
| No preview card on a port (S1)                        | T1                                  |
| Stop Flow in the failure banner (W5)                  | T1                                  |
| A palette click adds after the selected step (W1)     | T1                                  |
| The multi-select hint (X3)                            | none: no task selects several steps |
| The lens fold under the tabs (X4)                     | T15                                 |
| Lens rows that stay put, lighting (S10, S11)          | T15                                 |

## Comparison with round 2

| Round 3 | Round 2 | Same shape                                    |
| ------- | ------- | --------------------------------------------- |
| T1      | T3      | a failure path, plus inserting a step         |
| T2      | T2      | bind a step, plus optional parameters         |
| T10     | T4      | a check run, now on one group                 |
| T11     | T5      | a real run with inputs, now named cryptically |
| T12     | T8      | the failing scenario                          |
| T13     | T7      | the workspace's state                         |
| T15     | T9      | the Access lens                               |
| T16     | T11     | an outside change, now with the flow closed   |

T3-T9 and T14 are new, so they have no round to compare with.
