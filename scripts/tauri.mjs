#!/usr/bin/env node
/**
 * Runs the Tauri CLI on the desktop project, from wherever you happen to be.
 *
 * Two things it takes care of, so no one has to remember them:
 *
 * **The working directory.** The CLI finds its project by looking for
 * `tauri.conf.json` around the current directory, and ours lives in
 * `apps/desktop`. This runs it there whatever the caller's directory is.
 *
 * **The Windows entries in `PATH`, under WSL.** WSL appends the Windows `PATH`
 * to the Linux one, and `linuxdeploy` — the tool that builds the AppImage —
 * walks every entry of it. It reaches something like
 * `/mnt/c/WINDOWS/system32/config/systemprofile/AppData/Local/Microsoft/WindowsApps`,
 * gets `Permission denied`, throws, and the bundling fails with nothing but
 * `failed to run linuxdeploy`. Dropping the `/mnt/…` entries for the build fixes
 * it, and costs nothing: they hold Windows executables, which have no business
 * in a Linux build anyway. Outside WSL, `PATH` is passed through untouched.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = join(repoRoot, 'apps', 'desktop');
const onWindows = process.platform === 'win32';

/** WSL announces itself in the kernel version, and in its own variable. */
function runningUnderWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

const env = { ...process.env };
if (runningUnderWsl() && env.PATH) {
  const linuxOnly = env.PATH.split(':').filter((entry) => entry && !entry.startsWith('/mnt/'));
  if (linuxOnly.length < env.PATH.split(':').length) {
    console.log('[tauri] WSL detected: dropping the Windows entries from PATH for this build');
    env.PATH = linuxOnly.join(':');
  }
}

const cli = join(repoRoot, 'node_modules', '.bin', onWindows ? 'tauri.cmd' : 'tauri');

// A `.cmd` shim can only be spawned through a shell on Windows, and a shell
// needs the path quoted; everywhere else, spawn it directly.
const child = spawn(onWindows ? `"${cli}"` : cli, process.argv.slice(2), {
  cwd: desktopDir,
  stdio: 'inherit',
  shell: onWindows,
  env,
});

child.on('error', (error) => {
  console.error(`[tauri] could not start ${cli}: ${error.message}`);
  console.error('[tauri] run "npm install" first.');
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
