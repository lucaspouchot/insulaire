#!/usr/bin/env node
/**
 * Runs the Tauri CLI on the desktop project, from wherever you happen to be.
 *
 * Four things it takes care of, so no one has to remember them. Three of them
 * are the same story: `linuxdeploy`, the tool that builds the AppImage, reports
 * every failure as a bare `failed to run linuxdeploy`, so any of these costs a
 * full release build and a `--verbose` re-run to identify.
 *
 * **The working directory.** The CLI finds its project by looking for
 * `tauri.conf.json` around the current directory, and ours lives in
 * `apps/desktop`. This runs it there whatever the caller's directory is.
 *
 * **The Windows entries in `PATH`, under WSL.** WSL appends the Windows `PATH`
 * to the Linux one, and `linuxdeploy` walks every entry of it. It reaches
 * something like
 * `/mnt/c/WINDOWS/system32/config/systemprofile/AppData/Local/Microsoft/WindowsApps`,
 * gets `Permission denied`, throws, and the bundling fails. Dropping the
 * `/mnt/…` entries for the build fixes it, and costs nothing: they hold Windows
 * executables, which have no business in a Linux build anyway. Outside WSL,
 * `PATH` is passed through untouched.
 *
 * **A `patchelf` that is on `PATH` without being runnable.** The AppImage
 * plugins call it by bare name and exit 127 without it. It is a listed build
 * prerequisite, so the usual cause is not a missing package but a version
 * manager shadowing it — see `patchelfProblem`. Checked before the build, and
 * reported as itself.
 *
 * **A host that builds its libraries with relr relocations.** `linuxdeploy`
 * ships its own `strip`, from a binutils old enough not to know the
 * `.relr.dyn` section type, and it fails on every library it is handed. Arch
 * and its relatives, and any recent distribution, hit this; Ubuntu 22.04 — what
 * the release workflow builds the AppImage on — does not. `NO_STRIP` is the
 * only lever `linuxdeploy` offers, so it goes on where relr is detected and
 * nowhere else: the AppImage is bigger, which beats not existing.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostBuildsWithRelr, patchelfProblem } from './linuxdeploy-env.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = join(repoRoot, 'apps', 'desktop');
const onWindows = process.platform === 'win32';
const args = process.argv.slice(2);

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

// Only `build` bundles an AppImage; `dev` and `icon` never reach linuxdeploy.
if (process.platform === 'linux' && args[0] === 'build') {
  const problem = patchelfProblem();
  if (problem) {
    console.error(`[tauri] patchelf cannot be run: ${problem}`);
    console.error('[tauri] the AppImage plugins need it. Install it for the system');
    console.error('[tauri] (Arch: pacman -S patchelf, Debian: apt install patchelf), and if a');
    console.error('[tauri] version manager shims the name, make the real one win on PATH.');
    process.exit(1);
  }

  if (!env.NO_STRIP && hostBuildsWithRelr()) {
    console.log('[tauri] relr relocations detected: setting NO_STRIP for this build');
    console.log("[tauri] (linuxdeploy's bundled strip cannot read them; the AppImage grows)");
    env.NO_STRIP = '1';
  }
}

const cli = join(repoRoot, 'node_modules', '.bin', onWindows ? 'tauri.cmd' : 'tauri');

// A `.cmd` shim can only be spawned through a shell on Windows, and a shell
// needs the path quoted; everywhere else, spawn it directly.
const child = spawn(onWindows ? `"${cli}"` : cli, args, {
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
