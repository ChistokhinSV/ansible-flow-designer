# Wave 8 usability test: tasks

The cards the runner shows (`scripts/usability/tasks.ts`), with variant A's names. Variant B
(round 2) has the same flows with the names in the table at the end. Cards say what to achieve,
never which control to use, so the same card fits 0.50.0 and the wave 8 build. The **check** is
what the verifier (`scripts/usability/verify.ts`) looks at; **wave 8** is what the group is meant to
change for this task. A card's goal shows only after its Start (round 1: a goal shown earlier was
worked on with the clock stopped). The verifier matches names by their words, plural and case
aside, with one swapped letter allowed in a word of six letters or more; a renamed step counts by
its old or new title.

## Part 1: build and run

| Task | Card (variant A)                                                                                                                                                                           | Limit | Check                                                                                           | Wave 8                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------- | -------------------------------------- |
| T1   | Create a new flow named "Backup configs" that first checks each device answers ("Check the device answers"), then saves its running config ("Save the running config"). No modules needed. | 6 min | A new flow: start, the two steps in order, an end                                               | none (core)                            |
| T2   | In "NTP baseline", make "Set the login banner" use `ansible.builtin.lineinfile` to write "Authorized access only" into `/etc/issue.net`. Save.                                             | 6 min | The step is bound to the module with `path` and `line`                                          | C: Configure first, a parameter search |
| T3   | In "NTP baseline", hosts that fail "Check NTP status" must not continue and end in "Stopped". Save.                                                                                        | 5 min | The step's failed hosts reach a failed end (directly or through a pattern's step)               | none (core)                            |
| T4   | Run "Branch health check" as a check on all lab switches (group `lab`). Which step failed for which switch?                                                                                | 8 min | A finished check run in the audit; the answer names lab-sw-03 (firmware) and lab-sw-04 (uplink) | A: the canvas shows the run as it goes |
| T5   | Run "NTP rollout" for real on the lab group with NTP servers 10.20.0.10, 10.20.0.11; time zone UTC; change ticket CHG-1042.                                                                | 8 min | A real run on all 4 lab hosts that finished with nothing failed                                 | B: one dialog instead of 5 prompts; A  |

## Part 2: find and review

| Task | Card (variant A)                                                                                                                                                    | Limit | Check                                                                                                        | Wave 8                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| T6   | In "Data centre upgrade", on every level: which steps are not implemented yet, and which steps are approvals? Name each one.                                        | 6 min | The answer names the 4 unimplemented steps and the 2 approvals                                               | D: Find filters                                |
| T7   | Overview of the repository, opening as few flows as possible: which flow has an error that stops code generation, and whose generated playbook was changed by hand? | 5 min | The answer names "Firewall audit" and "Config backup rotation"                                               | D: the Flows view with problems and code state |
| T8   | Run the scenario tests of "Branch health check". One fails: which switch ended where, where was it expected, and why?                                               | 6 min | The answer names lab-sw-04, Stopped, and Reported to NetOps                                                  | E: scenario results on the canvas              |
| T9   | In "Data centre upgrade", with the Access lens: "Restart the time service" needs root (keep it, record why); "Write the drift report" does not (fix it). Save.      | 6 min | The first keeps become, its lens finding accepted with a reason; the second has no become                    | F: lens findings in Details                    |
| T10  | In "Release pipeline", put "Lint", "Unit tests" and "Package" in a straight column, evenly spaced, without moving any other step. Save.                             | 5 min | The three share a column (or row) within 2 px with even gaps; every other node where it was                  | G: Align and Distribute                        |
| T11  | Keep "Data centre upgrade" open and saved. On Start the kit plays a coding agent that edits the flow on disk. What did it change?                                   | 6 min | The answer names the added "Check BGP sessions", the renamed "Verify services and VIPs" and "Copy the image" | H: marks on steps changed outside the designer |

## What the workspace holds

The kit builds it with the repository's flow code (`scripts/usability/workspace.ts`), so each flow
is valid for the build under test and `generated/` matches its engine.

| Flow (variant A)       | Folder             | Used in     | Planted on purpose                                                                          |
| ---------------------- | ------------------ | ----------- | ------------------------------------------------------------------------------------------- |
| NTP baseline           | `flows/network`    | T2, T3      | An unbound step; an open fail port                                                          |
| Branch health check    | `flows/network`    | T4, T8      | Two asserts that fail for one host each; a scenario that expects the wrong end              |
| NTP rollout            | `flows/network`    | T5          | Three required inputs (a list and two strings)                                              |
| Data centre upgrade    | `flows/datacenter` | T6, T9, T11 | 5 subflows, 4 unimplemented steps, 2 approvals, 2 steps with become unlike their neighbours |
| Release pipeline       | `flows/platform`   | T10         | Hand-placed nodes and a section; three steps placed unevenly                                |
| Firewall audit         | `flows/security`   | T7          | A wire to a port that does not exist (an error)                                             |
| Config backup rotation | `flows/platform`   | T7          | Its generated playbook edited by hand                                                       |

The inventory `inventory/lab.ini` has four hosts with `ansible_connection=local`. Their variables
make the asserts fail: lab-sw-03 has firmware 16.9, lab-sw-04 one uplink.

## Variant B names

| Variant A                                                           | Variant B                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| switches lab-sw-01 to lab-sw-04                                     | routers lab-rt-11 to lab-rt-14                                             |
| Backup configs / Save the running config                            | Collect inventory / Record serial numbers                                  |
| NTP baseline / Set the login banner                                 | Syslog baseline / Set the message of the day                               |
| `/etc/issue.net`, "Authorized access only"                          | `/etc/motd`, "Managed by NetOps"                                           |
| Check NTP status                                                    | Check syslog status                                                        |
| Branch health check: firmware (lab-sw-03), uplink (lab-sw-04)       | Campus health check: software (lab-rt-12), power supplies (lab-rt-14)      |
| NTP rollout: ntp_servers, timezone, change_ticket CHG-1042          | Syslog rollout: syslog_servers, facility, change_ticket CHG-2087           |
| Data centre upgrade                                                 | Edge router upgrade                                                        |
| Restart the time service / Write the drift report                   | Reload the routing daemon / Write the audit summary                        |
| Release pipeline: Lint, Unit tests, Package                         | Image pipeline: Validate, Scan, Build                                      |
| Firewall audit / Config backup rotation                             | ACL audit / Log archive rotation                                           |
| Agent: Check BGP sessions, Verify services and VIPs, Copy the image | Agent: Check OSPF neighbours, Verify routes and prefixes, Copy the package |
