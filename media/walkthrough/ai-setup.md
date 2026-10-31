# Other agents: set up once

| Agent                           | Skill copy                              | Flow tools                         |
| ------------------------------- | --------------------------------------- | ---------------------------------- |
| Claude Code (CLI and extension) | `.claude/skills/`                       | `claude mcp add -s user`           |
| Codex                           | `.agents/skills/`                       | `~/.codex/config.toml`             |
| Gemini CLI                      | `.agents/skills/`, `~/.gemini/skills/`  | `~/.gemini/settings.json`          |
| OpenCode                        | `.agents/skills/`                       | `~/.config/opencode/opencode.json` |
| ZCode                           | `.agents/skills/`                       | `~/.agents/mcp.json`               |
| GitHub Copilot CLI              | `.github/skills/`, `~/.copilot/skills/` | `~/.copilot/mcp-config.json`       |
| Cursor                          | `.claude/skills/`                       | `~/.cursor/mcp.json`               |
- **This repository** puts the skill next to your flows (commit it for the team), **Just me** in
  your home folder. The flow tools are always registered for you only.
- Config files get a one-time `.afd-backup` copy. _Remove AI Assistant Setup…_ takes it all back.
- Any other agent: pick **Other agent…** for its MCP config and a copy of the skill.
- Restart agents that are already running.
