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

/* ---------------------------------------------------------------- branding */

/** Small monochrome goat derived from the GOAT ROUTER identity (6 rows). */
export const GOAT_ART = [
  "     ___",
  "    (o o)",
  "   /GOAT \\",
  "   \\_____/",
  "     | |",
  "     ---",
].join("\n");

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

/** True when both fds are interactive terminals. */
export function isTty() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
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
