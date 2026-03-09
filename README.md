# claude-view

Instantly review what Claude Code changed.

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)

## What it does

Claude Code works great from the terminal, but reviewing its changes usually means switching to an IDE or squinting at `git diff` output. `claude-view` adds a `/view` command that instantly opens a single page in your browser with every change, side by side, so you can review it all at a glance.

No setup, no API keys, no dependencies.

## Install

Run this in your terminal:

```bash
curl -sL https://raw.githubusercontent.com/icanb/claude-view/main/install.sh | bash
```

That's it. The `/view` command is now available in all your Claude Code sessions.

## Usage

Type `/view` in Claude Code. It instantly opens a side-by-side diff of all uncommitted changes in your browser.

### Direct CLI usage

You can also run the script directly:

```bash
node /path/to/claude-view/scripts/generate-diff.mjs
```

An interactive arrow-key menu will appear in your terminal. Or pass a flag directly:

```bash
node scripts/generate-diff.mjs --unstaged    # default: all uncommitted changes
node scripts/generate-diff.mjs --latest      # last Claude Code turn with file changes
node scripts/generate-diff.mjs --session     # all changes in the current session
node scripts/generate-diff.mjs HEAD~3        # any git ref
```

## How it works

- **Session diffs** (`--latest`, `--session`): Parses Claude Code's JSONL session transcripts to extract `Write` and `Edit` tool calls, then reconstructs the diffs.
- **Git diffs** (`--unstaged`, git refs): Runs `git diff` and parses the output.
- **HTML generation**: Produces a single self-contained HTML file with embedded CSS. No JavaScript frameworks, no external assets.

## Contributing

Contributions are very welcome! The codebase is intentionally simple (a single script with zero dependencies) so it's easy to jump in. Found a bug? Have an idea? [Open an issue](https://github.com/icanb/claude-view/issues) or submit a PR.

## License

[MIT](LICENSE)
