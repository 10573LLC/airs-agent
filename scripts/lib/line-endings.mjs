// Repository check: tracked shell scripts must use LF.
//
// A CRLF-terminated shebang line ("#!/bin/sh\r\n") makes Linux containers fail
// with "/bin/sh^M: bad interpreter", which is exactly how the Windows clone of
// this repository broke the PostgreSQL init scripts.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const SHELL_EXTENSIONS = [".sh", ".bash", ".zsh"];

/** True when the buffer contains a CR immediately followed by LF. */
export function hasCrlf(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), "utf8");
  for (let i = 0; i < bytes.length - 1; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) return true;
  }
  return false;
}

export function isShellPath(file) {
  return SHELL_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext));
}

/** Tracked shell scripts, relative to the repository root. */
export function listTrackedShellFiles(cwd = process.cwd()) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" });
  return out.split("\0").filter((f) => f.length > 0 && isShellPath(f));
}

/** Returns the subset of `files` that contain CRLF on disk. */
export function findCrlfFiles(files, cwd = process.cwd()) {
  return files.filter((file) => {
    try {
      return hasCrlf(readFileSync(`${cwd}/${file}`));
    } catch {
      return false; // deleted-but-tracked paths are not a line-ending failure
    }
  });
}

/** Full repository check. Returns { checked, offenders }. */
export function checkShellLineEndings(cwd = process.cwd()) {
  const files = listTrackedShellFiles(cwd);
  return { checked: files, offenders: findCrlfFiles(files, cwd) };
}
