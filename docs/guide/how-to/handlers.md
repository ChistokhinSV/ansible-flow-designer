# Handlers: notify and listen

A handler is a step that runs only where something changed: restart a service after its config
was written, reload a firewall after a rule was added. In a flow it is a step like any other, at
its place on the hosts' way, that runs for the hosts on which a step notifying it changed
something. The other hosts pass by it.

## Make one

1. Select the step that should run only when needed (the restart) and tick **Runs when
   notified** in its Details. A bell shows on it.
2. Select the step that makes the change (the config) and type the handler's key in
   **Notifies**. A dashed blue line on the canvas joins the two.
3. Put the handler after the step on the hosts' way, on the same level.

The generated code runs the handler with
`when: (<notifying step>_result | default({})) is changed or …`: once per host, however many
steps notified it.

## Topics

A handler can also **listen** to topics (Ansible's `listen`): a step that notifies the topic
reaches every handler of its level that listens to it. In Details, **Listens to** takes the
topics, commas between; **Notifies** takes keys and topics alike.

```yaml
- key: write-config
  type: task
  title: Write the web config
  impl:
    kind: module
    ref: ansible.builtin.template
    params:
      src: templates/web.conf.j2
      dest: /etc/web.conf
  notify: [restart-web]
- key: restart-web
  type: task
  title: Restart web
  impl:
    kind: module
    ref: ansible.builtin.service
    params:
      name: web
      state: restarted
  notified:
    listen: [web settings changed]
```

## What the designer checks

| Problem              | Means                                                                        |
| -------------------- | ---------------------------------------------------------------------------- |
| `notify-unknown`     | a name in Notifies is no handler's key and no topic a handler listens to     |
| `notify-no-change`   | the notifying step cannot report a change: only a step bound to a module can |
| `handler-not-after`  | the handler is not after the notifying step on the hosts' way                |
| `handler-unnotified` | nothing notifies the handler: it never runs                                  |

## Import

Playbook handlers become handler steps after the tasks (and at each `meta: flush_handlers`), and the
tasks that notified them name them in **Notifies**. A handler whose notifying tasks are inside a
block (a subflow, another level) keeps the generated `when` instead, since links stay on one level.

## See also

- [Import playbooks and AWX templates](import.md)
- [Data between steps](data-between-steps.md): registers and outputs
