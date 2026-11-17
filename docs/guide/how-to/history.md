# History

Flows are files in git, so their history is git's: who changed what, when, and why. The designer
shows it in two places: the **History** view for the whole folder, and **History…** for one flow.

## The History view

Open **Ansible Flows** in the Activity Bar; **History** is under **Flows**. It lists the folder's
commits, newest first: the message, the author, the day, and how many flows each one changed. Hover a
commit for its whole message and its files; expand it for the files.

- **Click a flow** of a commit to see it as that commit left it (below).
- **Click any other file** for VS Code's diff of what the commit changed in it.
- **Filter…** (the funnel on the view's title bar) keeps the commits that have all the words you
  type, in the message, the author's name or email, the commit hash or a file path: `dana firewall`
  finds Dana's commits that touched a firewall flow. **Clear Filter** shows all of them again.
- **Show 100 More…** at the end reads older commits.
- **Copy Commit Hash** is on a commit's right-click menu.

The view follows the folder by itself: a commit, a pull or a checkout shows at once.

## One flow's history

In the designer, **…** › **History…** (or right-click a flow in the **Flows** pane) lists the commits
that changed the flow or its scenario tests (`<key>.scenarios.yaml`), each with its author, day and
what it changed. Type to narrow the list by message, author or day; pick one to open it.

## A flow as a commit left it

The flow opens in the designer read-only, in the [Changes lens](lenses.md), compared with the version
just before the commit:

- a banner names the commit, its author, day and message;
- added and changed steps have chips, removed ones come back as ghosts where they stood, and the
  **Lens** tab lists every change;
- nothing can be edited or run there. To work on the flow, open the file itself.

The first commit of a flow has no version before it: the lens says the commit added the flow.

A folder that is not a git repository has no history; the view says so.
