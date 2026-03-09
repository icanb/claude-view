#!/usr/bin/env node

// Fully self-contained: interactive menu → diff parsing → HTML generation → browser open.
// No AI involved. Run directly or via Claude Code's /view command.

import { execSync } from "child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, basename, extname } from "path";

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  } catch {
    return "";
  }
}

// --- Interactive terminal menu ---

function interactiveMenu(options) {
  return new Promise((resolve) => {
    let selected = 0;
    const { stdin, stdout } = process;

    function render() {
      stdout.write(`\x1b[${options.length + 2}A\x1b[J`);
      stdout.write("\x1b[1m  What would you like to diff?\x1b[0m\n\n");
      for (let i = 0; i < options.length; i++) {
        if (i === selected) {
          stdout.write(`  \x1b[36m❯ ${options[i].label}\x1b[0m\n`);
        } else {
          stdout.write(`    \x1b[2m${options[i].label}\x1b[0m\n`);
        }
      }
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    stdout.write("\n".repeat(options.length + 2));
    render();

    stdin.on("data", (key) => {
      if (key === "\x1b[A" || key === "k") {
        selected = (selected - 1 + options.length) % options.length;
        render();
      } else if (key === "\x1b[B" || key === "j") {
        selected = (selected + 1) % options.length;
        render();
      } else if (key === "\r" || key === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write("\n");
        resolve(options[selected].value);
      } else if (key === "\x03" || key === "q") {
        stdin.setRawMode(false);
        stdout.write("\n");
        process.exit(0);
      }
    });
  });
}

// --- Session parsing ---

function getProjectSessionDir(cwd) {
  const encoded = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", encoded);
}

function getLatestSessionFile(sessionDir) {
  try {
    const files = readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        name: f,
        path: join(sessionDir, f),
        mtime: statSync(join(sessionDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path || null;
  } catch {
    return null;
  }
}

function parseSession(sessionFile, { latestOnly = false } = {}) {
  const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");

  const turns = [];
  let currentTurn = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "user") {
      const msg = entry.message;
      let text = "";
      if (msg && typeof msg === "object") {
        for (const block of msg.content || []) {
          if (block.type === "text") text += block.text;
        }
      } else if (typeof msg === "string") {
        text = msg;
      }
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { userText: text, writes: [], edits: [], assistantTexts: [] };
    }

    if (entry.type === "assistant" && currentTurn) {
      const msg = entry.message || {};
      for (const block of msg.content || []) {
        if (block.type === "text" && block.text?.trim()) {
          currentTurn.assistantTexts.push(block.text);
        }
        if (block.type === "tool_use") {
          const { name, input } = block;
          if (name === "Write" || name === "write") {
            currentTurn.writes.push({ file: input.file_path, content: input.content });
          }
          if (name === "Edit" || name === "edit") {
            currentTurn.edits.push({
              file: input.file_path,
              old: input.old_string,
              new: input.new_string,
            });
          }
        }
      }
    }
  }
  if (currentTurn) turns.push(currentTurn);

  if (latestOnly) {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.writes.length > 0 || t.edits.length > 0) {
        return {
          writes: t.writes,
          edits: t.edits,
          summary: {
            userRequest: t.userText.slice(0, 500),
            assistantResponse: t.assistantTexts.join("\n").slice(0, 1000),
          },
        };
      }
    }
    return { writes: [], edits: [], summary: null };
  }

  const writes = turns.flatMap((t) => t.writes);
  const edits = turns.flatMap((t) => t.edits);
  const userMsgs = turns.map((t) => t.userText).filter(Boolean);
  return {
    writes,
    edits,
    summary: {
      userRequest: userMsgs.map((m) => m.slice(0, 200)).join("\n"),
      assistantResponse: "",
    },
  };
}

// --- Diff building ---

function buildSessionDiff(writes, edits) {
  const fileOps = new Map();
  for (const w of writes) {
    if (!fileOps.has(w.file)) fileOps.set(w.file, { writes: [], edits: [] });
    fileOps.get(w.file).writes.push(w);
  }
  for (const e of edits) {
    if (!fileOps.has(e.file)) fileOps.set(e.file, { writes: [], edits: [] });
    fileOps.get(e.file).edits.push(e);
  }

  const fileDiffs = [];

  for (const [file, ops] of fileOps) {
    const hunks = [];

    if (ops.writes.length > 0) {
      const lastWrite = ops.writes[ops.writes.length - 1];
      const newLines = lastWrite.content.split("\n");

      if (ops.writes.length > 1) {
        const prevWrite = ops.writes[ops.writes.length - 2];
        const oldLines = prevWrite.content.split("\n");
        // Build line-by-line diff rows for session writes
        hunks.push(buildSessionHunkRows(oldLines, newLines, 1, 1));
      } else {
        // New file — all additions
        const rows = newLines.map((l, i) => ({ type: "add", oldLn: null, newLn: i + 1, text: l }));
        hunks.push({ rows, header: `@@ -0,0 +1,${newLines.length} @@`, isNew: true });
      }
    }

    for (const edit of ops.edits) {
      const oldLines = edit.old.split("\n");
      const newLines = edit.new.split("\n");
      const rows = [];
      for (const l of oldLines) rows.push({ type: "del", oldLn: null, newLn: null, text: l });
      for (const l of newLines) rows.push({ type: "add", oldLn: null, newLn: null, text: l });
      hunks.push({ rows, header: "@@" });
    }

    fileDiffs.push({ file, hunks });
  }

  return fileDiffs;
}

function buildSessionHunkRows(oldLines, newLines, oldStart, newStart) {
  // Simple line-by-line pairing for session diffs (no context available)
  const rows = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oldLn = oldStart;
  let newLn = newStart;

  for (let i = 0; i < maxLen; i++) {
    const hasOld = i < oldLines.length;
    const hasNew = i < newLines.length;

    if (hasOld && hasNew && oldLines[i] === newLines[i]) {
      rows.push({ type: "ctx", oldLn: oldLn++, newLn: newLn++, text: newLines[i] });
    } else {
      if (hasOld) rows.push({ type: "del", oldLn: oldLn++, newLn: null, text: oldLines[i] });
      if (hasNew) rows.push({ type: "add", oldLn: null, newLn: newLn++, text: newLines[i] });
    }
  }

  return { rows, header: `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@` };
}

// Parse git diff preserving context lines and real line numbers
function parseGitDiff(rawDiff) {
  const fileDiffs = [];
  const fileChunks = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split("\n");
    const headerMatch = lines[0].match(/a\/(.*?) b\/(.*)/);
    if (!headerMatch) continue;
    const file = headerMatch[2];
    const isNew = chunk.includes("new file mode");

    const hunks = [];
    let rows = [];
    let hunkHeader = "";
    let oldLn = 0;
    let newLn = 0;
    let inHunk = false;

    for (const line of lines) {
      if (line.startsWith("@@")) {
        if (inHunk && rows.length) {
          hunks.push({ rows, header: hunkHeader, isNew });
        }
        rows = [];
        hunkHeader = line;
        inHunk = true;

        // Parse @@ -oldStart,oldCount +newStart,newCount @@
        const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
        if (m) {
          oldLn = parseInt(m[1], 10);
          newLn = parseInt(m[2], 10);
          // Append function context if present
          if (m[3].trim()) hunkHeader = line;
        }
        continue;
      }
      if (!inHunk) continue;

      if (line.startsWith("-")) {
        rows.push({ type: "del", oldLn: oldLn++, newLn: null, text: line.slice(1) });
      } else if (line.startsWith("+")) {
        rows.push({ type: "add", oldLn: null, newLn: newLn++, text: line.slice(1) });
      } else if (line.startsWith(" ")) {
        rows.push({ type: "ctx", oldLn: oldLn++, newLn: newLn++, text: line.slice(1) });
      }
    }
    if (inHunk && rows.length) {
      hunks.push({ rows, header: hunkHeader, isNew });
    }

    fileDiffs.push({ file, hunks, isNew });
  }

  return fileDiffs;
}

// --- HTML generation ---

function esc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortPath(fullPath) {
  const c = process.cwd();
  if (fullPath.startsWith(c)) return fullPath.slice(c.length + 1);
  return fullPath.replace(/^\//, "");
}

// Map file extension to highlight.js language
function extToLang(file) {
  const map = {
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
    ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
    ".java": "java", ".kt": "kotlin", ".scala": "scala",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
    ".cs": "csharp", ".swift": "swift", ".m": "objectivec",
    ".php": "php", ".lua": "lua", ".r": "r",
    ".sh": "bash", ".bash": "bash", ".zsh": "bash",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "ini",
    ".xml": "xml", ".html": "xml", ".svg": "xml",
    ".css": "css", ".scss": "scss", ".less": "less",
    ".sql": "sql", ".graphql": "graphql",
    ".md": "markdown", ".mdx": "markdown",
    ".dockerfile": "dockerfile", ".docker": "dockerfile",
    ".tf": "hcl", ".hcl": "hcl",
    ".zig": "zig", ".nim": "nim", ".dart": "dart", ".ex": "elixir",
    ".erl": "erlang", ".hs": "haskell", ".ml": "ocaml",
    ".vue": "xml", ".svelte": "xml",
  };
  const ext = extname(file).toLowerCase();
  return map[ext] || "";
}

function renderFileDiff(fileDiff, index) {
  const shortName = shortPath(fileDiff.file);
  const lang = extToLang(fileDiff.file);
  let adds = 0;
  let dels = 0;
  let rows = "";

  for (const hunk of fileDiff.hunks) {
    rows += `<tr class="hk"><td colspan="5">${esc(hunk.header)}</td></tr>\n`;

    for (const row of hunk.rows) {
      if (row.type === "add") adds++;
      if (row.type === "del") dels++;

      const oldLn = row.oldLn != null ? row.oldLn : "";
      const newLn = row.newLn != null ? row.newLn : "";
      const marker = row.type === "add" ? "+" : row.type === "del" ? "−" : "";

      let trCls, lnCls, mkCls, cdCls;
      if (row.type === "add") {
        trCls = ""; lnCls = "ln ln-a"; mkCls = "mk mk-a"; cdCls = "cd cd-a";
      } else if (row.type === "del") {
        trCls = ""; lnCls = "ln ln-d"; mkCls = "mk mk-d"; cdCls = "cd cd-d";
      } else {
        trCls = ""; lnCls = "ln"; mkCls = "mk"; cdCls = "cd";
      }

      // For side-by-side: left = old, right = new
      if (row.type === "ctx") {
        // Context line: show on both sides
        const code = lang ? `<code class="language-${lang}">${esc(row.text)}</code>` : esc(row.text);
        rows += `<tr><td class="${lnCls}">${oldLn}</td><td class="${mkCls}"></td><td class="${cdCls}">${code}</td><td class="${lnCls}">${newLn}</td><td class="${mkCls}"></td><td class="${cdCls}">${code}</td></tr>\n`;
      } else if (row.type === "del") {
        const code = lang ? `<code class="language-${lang}">${esc(row.text)}</code>` : esc(row.text);
        rows += `<tr><td class="${lnCls}">${oldLn}</td><td class="${mkCls}">${marker}</td><td class="${cdCls}">${code}</td><td class="ln ln-empty"></td><td class="mk mk-empty"></td><td class="cd cd-empty"></td></tr>\n`;
      } else {
        const code = lang ? `<code class="language-${lang}">${esc(row.text)}</code>` : esc(row.text);
        rows += `<tr><td class="ln ln-empty"></td><td class="mk mk-empty"></td><td class="cd cd-empty"></td><td class="${lnCls}">${newLn}</td><td class="${mkCls}">${marker}</td><td class="${cdCls}">${code}</td></tr>\n`;
      }
    }
  }

  const badge = fileDiff.isNew || fileDiff.hunks.some((h) => h.isNew)
    ? '<span class="bn">new</span>'
    : '<span class="bm">modified</span>';

  const id = `file-${index}`;
  return {
    html: `<details class="fd" id="${id}" open>
    <summary><div class="fh"><span class="ar">&#9656;</span>${badge}${esc(shortName)}<span style="margin-left:auto;font-weight:400;color:#8b949e">+${adds} −${dels}</span></div></summary>
    <table class="dt">${rows}</table>
  </details>`,
    adds,
    dels,
    shortName,
    id,
  };
}

function generateHTML(fileDiffs, meta) {
  let fileBlocks = "";
  let totalAdds = 0;
  let totalDels = 0;
  const fileEntries = [];

  for (let i = 0; i < fileDiffs.length; i++) {
    const { html, adds, dels, shortName, id } = renderFileDiff(fileDiffs[i], i);
    fileBlocks += html;
    totalAdds += adds;
    totalDels += dels;
    fileEntries.push({ shortName, adds, dels, id });
  }

  const sidebarItems = fileEntries
    .map(
      (f) =>
        `<a class="si" href="#${f.id}"><span class="si-name">${esc(f.shortName)}</span><span class="si-stat"><span class="sa">+${f.adds}</span> <span class="sd">−${f.dels}</span></span></a>`,
    )
    .join("\n");

  function renderMarkdownish(text) {
    return esc(text).replace(/`([^`]+)`/g, '<code style="background:#1c2128;padding:2px 6px;border-radius:4px;font-size:13px;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,monospace">$1</code>');
  }

  let summaryInner = "";
  if (meta.summary) {
    const { userRequest, assistantResponse } = meta.summary;
    if (userRequest) {
      summaryInner += `<div style="margin-bottom:12px"><strong style="color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">What was requested</strong><p style="margin-top:4px">${renderMarkdownish(userRequest)}</p></div>`;
    }
    if (assistantResponse) {
      summaryInner += `<div><strong style="color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">What was done</strong><p style="margin-top:4px">${renderMarkdownish(assistantResponse)}</p></div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>claude-view</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:#0d1117;color:#e6edf3;line-height:1.5}
.top{max-width:1400px;margin:0 auto;padding:24px 16px 0}
.c{max-width:1400px;margin:0 auto;padding:16px;display:flex;gap:16px}
.sidebar{width:260px;flex-shrink:0;position:sticky;top:16px;align-self:flex-start;max-height:calc(100vh - 32px);overflow-y:auto;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px 0}
.sidebar-title{font-size:12px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;padding:0 12px 8px;border-bottom:1px solid #30363d;margin-bottom:4px}
.si{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;text-decoration:none;color:#e6edf3;font-size:12px;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;border-left:2px solid transparent}
.si:hover{background:#1c2128;border-left-color:#58a6ff}
.si-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px}
.si-stat{flex-shrink:0;font-size:11px}
.main{flex:1;min-width:0}
.ph{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:24px;margin-bottom:16px}
.pt{font-size:26px;font-weight:600;margin-bottom:4px}
.pm{color:#8b949e;font-size:14px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.pb{background:#122d42;color:#58a6ff;padding:2px 8px;border-radius:12px;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:12px;font-weight:500}
.ps{background:#238636;color:#fff;padding:4px 12px;border-radius:16px;font-size:13px;font-weight:600}
.st{display:flex;gap:12px;margin-top:12px;font-size:13px;color:#8b949e}
.sa{color:#3fb950;font-weight:600}.sd{color:#f85149;font-weight:600}
.fd{background:#161b22;border:1px solid #30363d;margin-bottom:16px;border-radius:6px;overflow:hidden}
.fd summary{cursor:pointer;list-style:none}
.fd summary::-webkit-details-marker{display:none}
.fh{background:#1c2128;padding:10px 16px;font-size:13px;font-weight:600;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:8px;color:#e6edf3}
.ar{transition:transform .2s;display:inline-block}
details[open] .ar{transform:rotate(90deg)}
.bn,.bm{font-size:11px;padding:1px 6px;border-radius:8px;font-weight:500;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.bn{background:#1b3826;color:#3fb950}
.bm{background:#3b2e00;color:#d29922}
.dt{width:100%;border-collapse:collapse;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:12px;line-height:20px}
.dt td{padding:0 10px;vertical-align:top;white-space:pre-wrap;word-wrap:break-word}
.dt code{font-family:inherit;background:none!important;padding:0!important;margin:0!important;font-size:inherit!important;line-height:inherit!important}
.ln{width:40px;color:#484f58;text-align:right;padding:0 8px!important;user-select:none;font-size:12px;white-space:nowrap;border-right:1px solid #21262d}
.mk{width:20px;text-align:center;padding:0!important;user-select:none;font-size:12px;color:#484f58}
.cd{border-right:1px solid #21262d}
.ln-a{background:#0f2d1a;color:#3fb950}.mk-a{background:#12261e;color:#3fb950}.cd-a{background:#12261e}
.ln-d{background:#311b1f;color:#f85149}.mk-d{background:#2a1115;color:#f85149}.cd-d{background:#2a1115}
.ln-empty{background:#0d1117}.mk-empty{background:#0d1117}.cd-empty{background:#0d1117}
.hk{background:#122d42;color:#8b949e;font-style:italic}.hk td{padding:4px 10px}
.ft{text-align:center;padding:24px;color:#484f58;font-size:12px}
</style>
</head>
<body>
<div class="top">
  <div class="ph">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <span class="ps">${esc(meta.source === "git" ? "Git" : "Session")}</span>
      <h1 class="pt">${esc(meta.title)}</h1>
    </div>
    <div class="pm">
      <span class="pb">${esc(meta.branch || "unknown")}</span>
      <span>${esc(meta.log)}</span>
    </div>
    <div class="st">
      <span>${fileDiffs.length} file${fileDiffs.length !== 1 ? "s" : ""} changed</span>
      <span class="sa">+${totalAdds}</span>
      <span class="sd">−${totalDels}</span>
    </div>
    ${summaryInner ? `<div style="border-top:1px solid #30363d;margin-top:16px;padding-top:16px">${summaryInner}</div>` : ""}
  </div>
</div>
<div class="c">
  <nav class="sidebar">
    <div class="sidebar-title">Files changed (${fileDiffs.length})</div>
    ${sidebarItems}
  </nav>
  <div class="main">
    ${fileBlocks}
    <div class="ft">Generated by <a href="https://github.com/icanb/claude-view" style="color:#58a6ff;text-decoration:none;font-weight:600">claude-view</a></div>
  </div>
</div>
<script>
document.querySelectorAll('.dt code').forEach(el => {
  hljs.highlightElement(el);
  // Override hljs background
  el.style.background = 'none';
});
</script>
</body>
</html>`;
}

// --- Main ---

const cwd = process.cwd();
let mode = process.argv[2];

// Interactive menu if no argument and TTY available
if (!mode && process.stdin.isTTY) {
  mode = await interactiveMenu([
    { label: "Latest changes       What Claude just did", value: "--latest" },
    { label: "Full session         All changes in this session", value: "--session" },
    { label: "Unstaged changes     All uncommitted modifications", value: "--unstaged" },
    { label: "Last commit          Diff of the most recent commit", value: "HEAD~1" },
  ]);
}

// Default to --latest if no mode (non-TTY, e.g. from Claude Code)
if (!mode) mode = "--latest";

let fileDiffs = [];
let meta = { source: "", branch: "", log: "", title: "Code changes", summary: null };

if (mode === "--unstaged") {
  const raw = run("git diff HEAD");
  if (!raw.trim()) {
    console.error("No unstaged changes found.");
    process.exit(1);
  }
  fileDiffs = parseGitDiff(raw);
  meta.source = "git";
  meta.branch = run("git branch --show-current").trim();
  meta.log = "Uncommitted changes";
  meta.title = "Uncommitted changes";
} else if (mode === "--latest" || mode === "--session") {
  const latestOnly = mode === "--latest";
  const sessionDir = getProjectSessionDir(cwd);
  const sessionFile = getLatestSessionFile(sessionDir);
  if (!sessionFile) {
    console.error(`No Claude session found.\nLooked in: ${sessionDir}`);
    process.exit(1);
  }
  const { writes, edits, summary } = parseSession(sessionFile, { latestOnly });
  if (writes.length === 0 && edits.length === 0) {
    console.error("No file changes found.");
    process.exit(1);
  }
  fileDiffs = buildSessionDiff(writes, edits);
  meta.source = "session";
  meta.branch = "claude-session";
  meta.log = `${writes.length} write(s), ${edits.length} edit(s)`;
  meta.title = latestOnly ? "Latest changes" : "Full session changes";
  meta.summary = summary;
} else {
  const raw = run(`git diff ${mode} HEAD`);
  if (!raw.trim()) {
    console.error(`No diff found for ${mode}..HEAD`);
    process.exit(1);
  }
  fileDiffs = parseGitDiff(raw);
  meta.source = "git";
  meta.branch = run("git branch --show-current").trim();
  meta.log = run(`git log ${mode}..HEAD --oneline`).trim();
  meta.title = `Changes since ${mode}`;
}

// Generate HTML and open
const html = generateHTML(fileDiffs, meta);
const outPath = join(tmpdir(), `claude-view-${Date.now()}.html`);
writeFileSync(outPath, html);

const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
execSync(`${openCmd} "${outPath}"`);

console.log(`Opened: ${outPath}`);
