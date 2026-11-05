# Round 3 walkthrough (Claude, 0.64.1)

AFD-99. A cognitive walkthrough of round 3's tasks (`tasks.md`) before the session, with the method
of rounds 1 and 2 (`../wave8-usability/protocol.md`). It is an expert review, not a user test.

- **Webview steps** were tried in the harness (`just harness`, the `edge-baseline` fixture and the
  `ansible.builtin` catalog).
- **Host steps** were read from the code.
- **The kit:** a dry run built the variant C workspace, the self-test solved the file-checked
  tasks, and the verifier was run before and after it.

The four questions per step:

1. Will the person try to do it?
2. Will they notice the control?
3. Will they connect it with the effect?
4. Will they see it worked?

## Findings

Y numbers go on from the wave 9 walkthrough's Y1-Y4. Severity is Nielsen's 0-4; for a walkthrough
it is a prediction.

| ID  | Task    | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Sev | Area    |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------- |
| Y5  | T5      | The flow's inputs editor has a type, a required box and a description, but no default value. A task asking for a default could not be done in the designer, so T5 asks for a required input.                                                                                                                                                                                                                                                                                                                              | 2   | I       |
| Y6  | T5, T11 | **Bug:** an input's description is lost when it is written. The command layer's `contract()` (`src/core/flow/commands.ts`) copies type, required, default, from and targets, not description. The description box keeps the typed text, but the flow does not get it (harness: "Site code, like fra1" typed for `site`, the flow's `site` without it). Flow tools hit the same command, so the kit's own descriptions for T11 are lost too. AFD-95 read descriptions everywhere but never wrote one through the designer. | 4   | bug (I) |
| Y7  | T8, T9  | Task keywords (`no_log`, `loop`) are in the Execution tab's fold titled **Tags**. Nothing in the other titles (Targeting, Privilege, Timing) points there. A person looking for "hide the output" or "once per zone" has to open a fold that says neither.                                                                                                                                                                                                                                                                | 2   | C       |
| Y8  | T4      | A module's returns, which become outputs in one click, are in the About fold, closed at the default width. The visible way is **Expose as node output**, which makes the whole result an output. The message then needs `.stdout` added by hand.                                                                                                                                                                                                                                                                          | 1   | C       |
| Y9  | T3      | Clearing a parameter means picking "default (false)" in its list. Nothing says that this removes it from the task.                                                                                                                                                                                                                                                                                                                                                                                                        | 1   | C       |

## The tasks

| Task | Shortest path on 0.64.1                                                                                                                      | Expected   | Notes                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| T1   | Select Check the firewall answers, click Task in the palette (it goes on the wire after it), title it; Stop Flow in the failure banner; save | pass       | W1, W5                                                       |
| T2   | Binding: find copy; Configure has `dest` required; Add a parameter finds `content`, `owner`, `mode`; Save Binding; save                      | pass       | round 2's T2 path, plus the search                           |
| T3   | Binding: `mode` to 0600, `backup` to "default (false)"; Save Binding; save                                                                   | pass       | Y9                                                           |
| T4   | Read the software version: Expose as node output (or About → Returns → stdout); Report the version: `@` in msg; Save Binding; save           | pass, slow | Y8                                                           |
| T5   | Flow panel: Inputs, new name, Add, required, description; Upload: `@` in url picks the flow input; save                                      | fail       | Y6 loses the description; Y5 changed the card                |
| T6   | Execution → Timing: Retries 10, Delay 15, Until (its help names `wait_policy_result`)                                                        | pass       |                                                              |
| T7   | Select the subflow, Execution → Targeting: Rolling batch 1                                                                                   | pass       |                                                              |
| T8   | Execution → Privilege: Become, Become user svc-backup; Execution → Tags → Task keywords `no_log: true`                                       | pass, slow | Y7                                                           |
| T9   | Execution → Tags → Task keywords `loop: [trust, untrust, dmz]`; Binding: `cmd` with `{{ item }}` (validates clean)                           | pass, slow | Y7                                                           |
| T10  | Run as Check; the dialog's host list is empty; the group chip `site_south · 3` lists its hosts; Run; Run Results and Output                  | pass       | wave 9 walkthrough: S2, X5, S3, S4                           |
| T11  | Run as Real; pick `lab`; fill rs_tag, mw, chg from their help lines; Run stays in view                                                       | review     | Y6: no help lines on 0.64.1, so the short names stay cryptic |
| T12  | Run Scenarios; the miss reads "lab-fw-36 ended at Stopped; the scenario expected Reported to SecOps"                                         | pass       | S9                                                           |
| T13  | Problems panel (every flow), or the flow panel's workspace line, or the Flows view                                                           | pass       | S8                                                           |
| T14  | Problems → the playbook warning → Open the Flow; Find old archives: `age` 30d; save; the toast's Overwrite (Generate Code asks the same)     | pass       |                                                              |
| T15  | Access lens; accept Restart the log daemon's finding with a reason; clear Become on Write the upgrade summary; save                          | pass       | S10 and S11 patched in 0.59.3                                |
| T16  | Reopen Firewall upgrade: the note "3 steps changed since you last had this flow open", the marks; or the Git history                         | pass       | S12                                                          |

## The kit's dry run

- **The workspace** (variant C): nine flows. VPN audit has its planted error; the other eight have no
  problems.
- **The checks** on the untouched workspace: every file-checked task fails, and the answer tasks
  fail for want of an answer.
- **The self-test** then solves T1-T9, T14 and T15, and the checks pass them, all but T5, which the
  Y6 bug fails.
- **The solved flows** all validate clean. That includes `{{ item }}` in T9's command, Until in T6
  and Rolling in T7.
- **T16's change** arrives as two commits: "Work so far" by the session author, then R. Ortiz's
  change to Firewall upgrade. The runner shows the change's message. The kit recorded that the
  designer had never shown the flow; in a session, T7 and T15 will have.
- **Round 1 and 2 sessions,** checked again through the new study code, give the verdicts recorded
  for them (11 of 11 each).
- **Not tried in the dry run:** T10-T12 need runs in VS Code. Their checks read the run audit and
  each run's events, whose layout the dry run confirmed against round 2's session.

## Before the session

- **Y6 must be fixed in a patch (0.64.2)**, and the session must run on that build. On 0.64.1, T5
  fails whatever P1 does, and T11 shows no descriptions.
- Y5, Y7, Y8 and Y9 are predictions for the session to confirm or not; the cards stay as they are.
