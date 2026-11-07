# Wave 10 walkthrough (Claude, 0.68.0)

AFD-107. Round 3's findings (`../wave9-usability/round3.md`, R1-R13) checked on the last wave 10
build, with the method of the earlier walkthroughs (`../wave8-usability/protocol.md`).

**How it was checked.** Round 3's lesson was that a control can exist and still not explain itself.
So each finding was walked through the path P1 took, and the result was checked, not only the
control:
- the harness: the Execution tab with real typing, the outside note's list, the Privilege note;
- the integration suite:
  - a closed flow changed on disk lists its changes, and the lens compares with the flow as last
    shown;
  - a real scenario run carries what it forced;
  - an unfed input reaches the Problems panel;
- the unit tests named in each ticket.

It is an expert review, not a user test.

## Round 3's findings on 0.68.0

Severity is Nielsen's 0-4. The round 3 column is the session's; the 0.68.0 column is this
walkthrough's prediction.

| ID  | Finding (round 3)                                           | Round 3 | 0.68.0 | What changed, and how it was checked                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------- | ------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Four closed folds; Timing found only through the guide      | 3       | 0      | AFD-103: each fold names its fields ("Timing: timeout, retries, until, delay"), and Timing is open on a module step. Harness: open on Hello's ping step                                                                                                                                                                      |
| R2  | Timing fields do not say how they combine; Until never held | 3       | 1      | AFD-103. One sentence says what the task will do; Timeout reads "Limit for one try", Delay "Seconds between tries"; Until offers the result's fields. P1's own test (`result == "installed"`) is now the warning `until-whole-result`, shown under the field. Left at 1: a session has to show that people read the sentence |
| R3  | Task keywords under Tags                                    | 2       | 0      | AFD-103: a fold of their own that names when, loop and no_log, with one-click chips. `+ no_log` saves `no_log: true` in one click (webview test)                                                                                                                                                                             |
| R4  | The YAML box neither colours nor marks; no list indent      | 1       | 0      | AFD-103: colours, the wrong line underlined as you type, Enter as an editor. Harness, with real keys: `loop:` Enter `- trust` Enter `dmz` Enter Enter goes back to column 0                                                                                                                                                  |
| R5  | The @ button appended at the end                            | 2 (bug) | 0      | 0.64.3 (AFD-102); harness in Chromium                                                                                                                                                                                                                                                                                        |
| R6  | A new flow input is optional, with no default               | 2       | 0      | AFD-106: a Default box, read by type; a new input is required until it has a default                                                                                                                                                                                                                                         |
| R7  | A step input nothing feeds validated clean                  | 2       | 1      | AFD-106: the warning `input-unfed` names the step that registers the value, and the @ list offers that step's result. Left at 1, see Z1                                                                                                                                                                                      |
| R8  | "The scenario fails it here" was not understood             | 2       | 0      | AFD-105: "the scenario forces Check the HA pair is in sync to fail for it (force: failed), so it leaves by failed_hosts". The real scenario run carries `forced`                                                                                                                                                             |
| R9  | Marks say which steps changed, not what                     | 3       | 0      | AFD-104: the note lists each change ("Renamed Pre-checks to Pre-checks from a colleague", "Validate: settings changed (retries)"), and the Changes lens compares with the flow as last shown. Integration test                                                                                                               |
| R10 | Keeping a flagged become never asked for a reason           | 2       | 1      | AFD-106: the finding and the Privilege fold say to accept it with a reason, Accept first. Left at 1: still a note, not a step that asks                                                                                                                                                                                      |
| R11 | The resize handle worked on half its edge                   | 1 (bug) | 0      | 0.64.3 (AFD-102)                                                                                                                                                                                                                                                                                                             |
| R12 | Returns chips scrolled the panel sideways                   | 1 (bug) | 0      | 0.64.3 (AFD-102)                                                                                                                                                                                                                                                                                                             |
| R13 | The multi-select hint had no gap                            | 1 (bug) | 0      | 0.64.3 (AFD-102)                                                                                                                                                                                                                                                                                                             |

## New findings

| ID  | Where      | Finding                                                                                                                                                                                                                                                                                                         | Sev |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Z1  | Binding, @ | The @ list offers a step's whole result. To print its standard output, the person types `{{ read_version_result.stdout }}` by hand. A chip is `{{ name }}` alone, so `.stdout` typed after it is plain text. Until offers the result's fields (AFD-103); a parameter does not.                                  | 2   |
| Z2  | Execution  | A fold's open state is kept per group for every step, so closing Timing once closes it on every module step after. That is how folds behaved before; wave 10 only made Timing open by default.                                                                                                                  | 1   |
| Z3  | Problems   | `input-unfed` also fires on inputs that came from elsewhere without a source, such as a role's required argument added by Code mode's "Update Design" when no flow input had its name. The warning is right (nothing feeds them), and Accept keeps one. A flow that relied on host variables gets new warnings. | 1   |

## For round 4

- **Z1** is the one candidate for a patch: the @ list could offer the documented fields of a
  step's result (`<register>.stdout`, `.rc`) the way Until does, as text, not as a chip.
- **R2 and R10** are left at 1 until a session shows that people read the Timing sentence and act
  on the note.
