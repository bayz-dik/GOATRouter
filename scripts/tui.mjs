#!/usr/bin/env node
/**
 * GOAT ROUTER terminal UI (TUI) — a small operator control surface.
 *
 * This is intentionally NOT the web dashboard: it is a launcher/control plane
 * only. Provider, route, proxy, identity, and usage management stay in the Web
 * UI. The TUI shows server state and offers a short menu.
 *
 * Node standard library only, no TUI framework. The interaction model (Up /
 * Down / Enter / Esc / Back / Ctrl+C), raw-mode handling, and a guaranteed
 * terminal restore are small enough to own, and a dependency would bloat the
 * artifact and slow startup.
 *
 * Terminal-safety rules (covered by tests):
 *   - Never enter raw mode when stdin/stdout is not a TTY.
 *   - Always restore the terminal (cursor visible, raw off, echo on) on exit,
 *     on error, and on Ctrl+C.
 *   - Handle SIGWINCH/resize without crashing.
 *   - Keyboard input is read in-band; no shell utility is spawned.
 */

/* Node stdlib only — this module ships inside the artifact bundle and must not
 * pull a runtime dependency. */
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* ---------------------------------------------------------------- branding */

/**
 * Branding policy for the terminal operator surface.
 *
 * Two modes, decided per invocation by `imageCapability()`:
 *
 *   MODE A — terminal positively reports an inline-image protocol AND the
 *   approved character asset is available. Render the ACTUAL approved GOAT
 *   ROUTER character (a small inline image), never an ASCII approximation.
 *
 *   MODE B — everything else (normal Termux, xterm, SSH without passthrough).
 *   Draw NO fake character (no robot, no goat face, no Braille/Unicode
 *   portrait). Show a restrained monochrome GOAT ROUTER wordmark header.
 *
 * Detection never trusts `TERM` alone and never emits image escape garbage
 * into a terminal that has not positively opted in. When no protocol is
 * detected, `brandingRows` emits plain text only.
 */

/** The approved GOAT ROUTER character asset name (ships with the artifact). */
export const CHARACTER_ASSET = "goat-router-character.webp";
const APPROVED_BRAND_SUBDIR = "brand";

/**
 * True when both stdin and stdout are real interactive terminals.
 */
export function isTty() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Detect a terminal that positively reports an inline-image protocol we can
 * serve correctly with the approved asset bytes.
 *
 * We never infer an image protocol from `TERM` alone, and we never claim a
 * protocol whose bytes we cannot actually deliver. The approved character is a
 * WebP, and we will not add an image-decoder dependency to the artifact, so the
 * only protocol we advertise is iTerm2's inline image (OSC 1337), which renders
 * WebP natively and is signalled by the explicit TERM_PROGRAM=iTerm.app. A
 * kitty TERM is NOT treated as image-capable here: without a WebP->PNG
 * rasterizer we cannot guarantee kitty can decode the asset, and emitting an
 * un-decodable image would be garbage — the wordmark fallback is the honest
 * choice for kitty until a native-capable path exists.
 *
 * `env` defaults to process.env and `stdout` to process.stdout so tests can
 * simulate a supported terminal without a real one. Returns a capability
 * object, or null when no supported protocol is positively detected.
 */
export function imageCapability(env = process.env, stdout = process.stdout) {
  if (!(stdout && stdout.isTTY)) return null;
  if (env.TERM_PROGRAM === "iTerm.app") {
    return { protocol: "iterm2" };
  }
  return null;
}

/**
 * Resolve the approved character asset path for this run context.
 *
 * Returns a file path that exists for the CURRENT context, mirroring how the
 * control plane resolves everything else:
 *   - installed artifact: dist/control.mjs sits beside dist/dashboard/, so the
 *     approved character is dist/dashboard/brand/goat-router-character.webp.
 *   - source checkout: scripts/control.mjs sits in the repo, and the source of
 *     truth for the approved artwork is apps/dashboard/public/brand/.
 * Callers must check the path exists before emitting an image.
 */
export function assetDir(env = process.env, metaUrl = import.meta.url) {
  const here = dirname(fileURLToPath(metaUrl));
  const fromEnv = env.BAYZ_DASHBOARD_ROOT;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return join(fromEnv, APPROVED_BRAND_SUBDIR);
  }
  // Installed artifact: control.mjs -> ../dist/control.mjs; dashboard is a
  // sibling of dist. Source checkout: scripts/tui.mjs -> repo apps/dashboard.
  const dist = join(here, "dashboard", APPROVED_BRAND_SUBDIR);
  const app = join(here, "..", "apps", "dashboard", "public", APPROVED_BRAND_SUBDIR);
  return existsSync(dist) ? dist : app;
}

/** The packaged/resolved asset filename. */
export function characterAssetName() {
  return CHARACTER_ASSET;
}

/** The wordmark as terminal text (never requires an image capability). */
export function wordmark(version) {
  return `GOAT ROUTER  v${version}`;
}

/** A short human status line matching the three-way signal. */
export function statusText(state, url) {
  switch (state) {
    case "running":
      return "● Server   RUNNING";
    case "foreign":
      return "! Port in use by another process";
    case "degraded":
      return "! Server   DEGRADED";
    default:
      return "○ Server   STOPPED";
  }
}

/**
 * A clean monochrome header rule for the current terminal width. Never
 * truncates the wordmark; shortens decoration only. Returns "" on a very
 * narrow terminal where a rule would crowd the menu.
 */
export function rule(width) {
  const columns = Number.isFinite(width) && width > 0 ? Math.max(12, Math.floor(width)) : 48;
  if (columns < 20) return "";
  // Keep the rule comfortably inside the menu indentation.
  const n = Math.max(10, columns - 2);
  return "─".repeat(n);
}

/**
 * Build the branding header rows.
 *
 * MODE A — `cap` is a positively-detected image protocol we can serve AND the
 * approved character asset is available. The first block is the ACTUAL
 * approved character (inline image), then the wordmark line and status below
 * it. No ASCII approximation is ever drawn.
 *
 * MODE B — `cap` is null or the asset is missing (normal Termux, xterm, SSH,
 * kitty, a checkout without the dashboard build). A restrained monochrome
 * wordmark + rule header. NO fake character of any kind.
 *
 * `rows` are drawn at the top of the alternate screen. The inline image is
 * kept small (a bounded pixel width) so it never dominates the menu.
 *
 * Params:
 *   - cap: imageCapability result or null
 *   - version: product version
 *   - status/url: state line values
 *   - width: terminal columns (defaults to process.stdout.columns)
 *   - assetPath: resolved approved asset path (already exists), if cap present
 */
export function headerRows({ cap = null, version: ver, status, url = null, width = null, assetPath = null }) {
  const columns = Number.isFinite(width) && width > 0 ? Math.max(10, Math.floor(width)) : 48;
  const rows = [];
  const canImage = cap !== null && cap.protocol === "iterm2" && typeof assetPath === "string" && assetPath.length > 0;
  if (canImage) {
    rows.push(inlineImage(assetPath, columns));
    rows.push("");
  }
  // Wordmark line always present (Mode A shows it below the image; Mode B is
  // the header itself). wordmark(version) yields "GOAT ROUTER  v0.1.4".
  rows.push(`  ${wordmark(ver)}`);
  if (!canImage) rows.push(`  ${rule(columns)}`);
  rows.push(`  ${status}`);
  if (url !== null) rows.push(`  ${url}`);
  rows.push("");
  return rows;
}

/**
 * Emit the approved character as a small inline image (iTerm2 OSC 1337).
 *
 * Only called when imageCapability() has positively reported iTerm2, whose
 * inline-image protocol renders WebP natively, so the ACTUAL approved asset
 * bytes are embedded and no pixel decoding / no new dependency is needed. The
 * width is capped so the image stays a small header accent, never a
 * full-screen block.
 */
function inlineImage(assetPath, columns) {
  const name = basename(assetPath);
  const bytes = readFileSync(assetPath);
  const b64 = bytes.toString("base64");
  // Cap the rendered width to a modest header size regardless of how wide the
  // terminal is. iTerm2 keeps the aspect ratio, so a bounded width yields a
  // character ~6 terminal rows tall rather than the 1206x2144 source.
  const px = Math.max(40, Math.min(columns * 7, 220));
  return `\x1b]1337;File=name=${encodeURIComponent(name)};inline=1;width=${px}px:${b64}\x07`;
}


/* --------------------------------------------------------- terminal safety */

/**
 * Enter raw mode and return a cleanup that ALWAYS restores the terminal.
 * Throws when stdin is not a TTY, so raw mode is never entered off-terminal.
 * The cleanup restores cursor visibility, disables raw mode, restores echo,
 * and leaves the alternate screen buffer.
 */
export function enterRawMode() {
  if (!process.stdin.isTTY) {
    throw new Error("interactive TUI requires a terminal");
  }
  const stdin = process.stdin;
  const stdout = process.stdout;
  // Save the primary screen and switch to an alternate buffer.
  stdout.write("\x1b[?1049h");
  stdout.write("\x1b[?25l"); // hide cursor while drawing

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    try {
      // Leave the alternate buffer, then restore the cursor and attributes.
      stdout.write("\x1b[?1049l");
      stdout.write("\x1b[?25h");
      stdout.write("\x1b[0m");
      stdout.write("\n");
    } catch {
      // best effort
    }
    try {
      stdin.setRawMode(false);
      stdin.pause();
    } catch {
      // best effort
    }
  };

  const onInterrupt = () => {
    restore();
    process.exit(130); // 128 + SIGINT, the conventional Ctrl+C status
  };
  process.once("SIGINT", onInterrupt);
  return () => {
    process.removeListener("SIGINT", onInterrupt);
    restore();
  };
}

/** Render the full screen body, returning rows of text. */
export function frame(rows, title) {
  const all = [];
  all.push("");
  if (title !== undefined) all.push(`  ${title}`);
  for (const row of rows) all.push(row);
  all.push("");
  return all;
}

/** Clear and repaint the screen body from row 0. */
export function paint(rows) {
  process.stdout.write("\x1b[0;0H");
  process.stdout.write("\x1b[J");
  process.stdout.write(rows.join("\n"));
}

/**
 * Read a single logical key from a raw stdin. Arrow keys arrive as an escape
 * sequence; a lone Esc is Back. Ctrl+C is surfaced as its own value.
 */
export function readKey() {
  const stdin = process.stdin;
  return new Promise((resolve) => {
    let buf = "";
    const finish = (value) => {
      stdin.off("data", onData);
      resolve(value);
    };
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      if (buf === "\u0003") return finish("ctrl-c");
      if (buf === "\r" || buf === "\n") return finish("enter");
      if (buf === "\u001b[A") return finish("up");
      if (buf === "\u001b[B") return finish("down");
      if (buf === "\u001b[C") return finish("right");
      if (buf === "\u001b[D") return finish("left");
      if (buf === "\u001b") return finish("escape");
      if (buf.length >= 3) return finish("escape"); // unknown CSI -> treat as back
      // Otherwise wait for more bytes of a multi-byte sequence.
    };
    stdin.once("data", onData);
  });
}

/**
 * Run an interactive selection list. `options` are labels; returns the index
 * chosen with Enter, or "exit" on Ctrl+C / Esc-at-root. `backable` lets the
 * caller decide whether Esc returns "back" instead of "exit".
 *
 * This is the single input state machine the whole TUI is built on, so it is
 * kept tiny and side-effect-light to stay testable.
 */
export async function chooseIndex({ rows, options, backable = false }) {
  const restore = enterRawMode();
  let cursor = 0;
  const body = () => {
    const drawn = [];
    for (const row of rows) drawn.push(`  ${row}`);
    for (let i = 0; i < options.length; i += 1) {
      drawn.push(`  ${i === cursor ? "›" : " "} ${options[i]}`);
    }
    drawn.push("");
    return drawn;
  };
  const onResize = () => paint(body());
  process.stdout.on("resize", onResize);
  paint(body());
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const key = await readKey();
      if (key === "up") {
        cursor = (cursor - 1 + options.length) % options.length;
        paint(body());
      } else if (key === "down") {
        cursor = (cursor + 1) % options.length;
        paint(body());
      } else if (key === "enter") {
        return cursor;
      } else if (key === "escape") {
        return backable ? "back" : "exit";
      } else if (key === "ctrl-c") {
        return "exit";
      }
    }
  } finally {
    process.stdout.removeListener("resize", onResize);
    restore();
  }
}

/**
 * Render a transient message (an action result, a token, a health summary) that
 * stays on screen until the operator presses a key. Restores the terminal.
 */
export async function notice(lines) {
  const restore = enterRawMode();
  paint(frame(lines, undefined));
  process.stdout.write("  Press any key to continue.\n");
  process.stdout.write("\n");
  try {
    await readKey();
  } finally {
    restore();
  }
}

/** A helper that writes a plain (non-raw) screen and waits for Enter on stdin. */
export function pausePlain(lines) {
  paint(frame(lines, undefined));
  process.stdout.write("\n  [press Enter] ");
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => {
      process.stdout.write("\n");
      resolve();
    });
  });
}
