# Contract with Ansible Flow Server

What a client of [Ansible Flow Server](https://github.com/ChistokhinSV/ansible-flow-server) (the
VS Code extension's runner target) relies on, as data. The server replays these exchanges against
its real routes in its tests; a client replays them against a mock server. A change either side
makes that breaks the other shows in that side's tests.

Shipped in `@ansible-flow/assets` (`contractDir`).

## `server-api.json`

- `world`: what the server holds before the first exchange: people (`users`), access tokens
  (`tokens`, by name: owner, `readOnly`), one workspace, the owner's grants on it (`grants`), one
  project whose repository is the folder `repo/` committed on `branch`, and its launch
  configurations.
- `exchanges`, in order. Each has a `request` (`method`, `path`, `token`: a name from
  `tokens`, none for no sign-in; `body`), the `response` it gets (`status`, `body` pattern) and
  `capture`: values of the response body kept by name for later paths and patterns
  (`"0.id"`: the `id` of the first element).

A body pattern matches the response body when:

| Pattern                                | Matches                                                          |
| -------------------------------------- | ---------------------------------------------------------------- |
| an object                              | an object that has each named key, each matching; others ignored |
| an array                               | an array of the same length, element by element                  |
| `{ "$items": p }`                      | an array whose every element matches `p`                         |
| `{ "$contains": "t" }`                 | a string that contains `t`                                       |
| `"$string"`, `"$number"`, `"$boolean"` | a value of that type                                             |
| `"$uuid"`, `"$commit"`, `"$time"`      | a UUID, a 40-character git commit id, an ISO 8601 time           |
| `"$any"`                               | anything, also nothing                                           |
| `"${name}"`                            | the value captured as `name`                                     |
| anything else                          | that value                                                       |

The `version` at the top changes when a pattern's meaning changes.

## `repo/`

The project's files: a flow (`hello`), an inventory, and a flow in a format newer than any server
reads, which the server must refuse to run.
