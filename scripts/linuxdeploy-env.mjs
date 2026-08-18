/**
 * The two host conditions that make `linuxdeploy` fail while bundling the
 * AppImage, detected before the build rather than discovered inside a plugin.
 *
 * `linuxdeploy` reports every failure as a bare `failed to run linuxdeploy`,
 * whatever went wrong, so the real cause only appears under `--verbose` buried
 * in thousands of lines. Both conditions below cost a full release build to
 * find out. They are checked up front instead, by `scripts/tauri.mjs`.
 */

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';

/** Section type `SHT_RELR`: the compact relative relocations, `.relr.dyn`. */
const SHT_RELR = 19;

const ELF_MAGIC = 0x464c457f; // "\x7fELF", read little-endian.

/**
 * Whether an ELF file carries a `SHT_RELR` section.
 *
 * `read` takes an offset and a length and returns that slice of the file, so
 * this walks the section header table without loading the whole binary. It
 * returns false — never throws — on anything it does not recognise: a script,
 * a truncated file, a foreign architecture. "Not an ELF we can read" and "an
 * ELF without relr" lead to the same decision.
 */
export function hasRelrSection(read) {
  const header = read(0, 64);
  if (header.length < 64 || header.readUInt32LE(0) !== ELF_MAGIC) return false;

  const sixtyFourBit = header[4] === 2;
  const littleEndian = header[5] === 1;
  if (!littleEndian) return false; // No big-endian host runs this build.

  const sectionTableOffset = sixtyFourBit
    ? Number(header.readBigUInt64LE(0x28))
    : header.readUInt32LE(0x20);
  const entrySize = header.readUInt16LE(sixtyFourBit ? 0x3a : 0x2e);
  const entryCount = header.readUInt16LE(sixtyFourBit ? 0x3c : 0x30);

  // `entryCount === 0` means the real count lives in the first entry, a form
  // reserved for binaries with more than 65279 sections. No shared library is
  // one, so treat it as "cannot tell" rather than parse it.
  if (!sectionTableOffset || entrySize < 8 || entryCount === 0) return false;

  const table = read(sectionTableOffset, entrySize * entryCount);
  for (let entry = 0; entry + 8 <= table.length; entry += entrySize) {
    if (table.readUInt32LE(entry + 4) === SHT_RELR) return true;
  }
  return false;
}

/** `hasRelrSection` against a file on disk, false if it cannot be opened. */
export function fileHasRelrSection(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    return hasRelrSection((offset, length) => {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, read);
    });
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Whether this host builds its shared libraries with relr relocations.
 *
 * The sample is the set of system libraries this very Node process has mapped —
 * libc, libstdc++ and friends — which needs no guessing at where a distribution
 * keeps its libraries. A toolchain emitting relr emits it for all of them, so
 * one hit is the answer.
 */
export function hostBuildsWithRelr(libraries = systemLibrariesInUse()) {
  return libraries.some(fileHasRelrSection);
}

function systemLibrariesInUse() {
  try {
    // `linux-vdso.so.1` and the like have no path: they are not files.
    return process.report.getReport().sharedObjects.filter((path) => path.startsWith('/'));
  } catch {
    return [];
  }
}

/**
 * Why `patchelf` cannot be used, or null when it can.
 *
 * The AppImage plugins call a bare `patchelf` and exit 127 without it. A
 * version manager is the usual reason on a developer machine: `pyenv` and
 * friends put a shim first on `PATH` for every command name they have ever
 * seen installed in any environment, and that shim fails when the currently
 * selected environment is not the one holding the tool.
 */
export function patchelfProblem(run = spawnSync) {
  const probe = run('patchelf', ['--version'], { encoding: 'utf8' });
  if (probe.error) return probe.error.message;
  if (probe.status !== 0) {
    const said = `${probe.stderr ?? ''}${probe.stdout ?? ''}`.trim().split('\n')[0];
    return said || `exited with code ${probe.status}`;
  }
  return null;
}
