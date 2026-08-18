/**
 * The host checks that guard the AppImage build, tested directly.
 *
 * Run by `npm run test:scripts` (Node's built-in test runner, no dependency).
 * The ELF reader is the part worth pinning: it parses binaries it did not
 * produce, on machines we do not have, and every unreadable case must come back
 * as "no relr" rather than as an exception that fails the build.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fileHasRelrSection,
  hasRelrSection,
  hostBuildsWithRelr,
  patchelfProblem,
} from './linuxdeploy-env.mjs';

const SHT_PROGBITS = 1;
const SHT_RELA = 4;
const SHT_RELR = 19;

/** A minimal but well-formed ELF: a header, then one entry per section type. */
function elf(sectionTypes, { sixtyFourBit = true, littleEndian = true, entrySize = 64 } = {}) {
  const headerSize = 64;
  const buffer = Buffer.alloc(headerSize + entrySize * sectionTypes.length);
  buffer.writeUInt32LE(0x464c457f, 0);
  buffer[4] = sixtyFourBit ? 2 : 1;
  buffer[5] = littleEndian ? 1 : 2;

  if (sixtyFourBit) {
    buffer.writeBigUInt64LE(BigInt(headerSize), 0x28);
    buffer.writeUInt16LE(entrySize, 0x3a);
    buffer.writeUInt16LE(sectionTypes.length, 0x3c);
  } else {
    buffer.writeUInt32LE(headerSize, 0x20);
    buffer.writeUInt16LE(entrySize, 0x2e);
    buffer.writeUInt16LE(sectionTypes.length, 0x30);
  }

  sectionTypes.forEach((type, index) => {
    buffer.writeUInt32LE(type, headerSize + index * entrySize + 4);
  });
  return buffer;
}

/** The slice-reader `hasRelrSection` expects, over a buffer in memory. */
const readerFor = (buffer) => (offset, length) => buffer.subarray(offset, offset + length);

test('a 64-bit library with a relr section is recognised', () => {
  const buffer = elf([SHT_PROGBITS, SHT_RELR, SHT_RELA]);
  assert.equal(hasRelrSection(readerFor(buffer)), true);
});

test('a library relocated the old way is not', () => {
  const buffer = elf([SHT_PROGBITS, SHT_RELA, SHT_RELA]);
  assert.equal(hasRelrSection(readerFor(buffer)), false);
});

test('the 32-bit header layout is read too', () => {
  const buffer = elf([SHT_PROGBITS, SHT_RELR], { sixtyFourBit: false, entrySize: 40 });
  assert.equal(hasRelrSection(readerFor(buffer)), true);
});

test('a section table entry larger than we know about is still walked', () => {
  // Future ELF revisions may grow the entry; the type stays at offset 4 and
  // the stride comes from the header, so a bigger entry changes nothing.
  const buffer = elf([SHT_PROGBITS, SHT_RELR], { entrySize: 128 });
  assert.equal(hasRelrSection(readerFor(buffer)), true);
});

test('anything that is not a readable ELF answers no, and does not throw', () => {
  const notElf = Buffer.from('#!/bin/sh\necho hello\n'.padEnd(512, ' '));
  assert.equal(hasRelrSection(readerFor(notElf)), false);

  const truncated = elf([SHT_RELR]).subarray(0, 32);
  assert.equal(hasRelrSection(readerFor(truncated)), false);

  const bigEndian = elf([SHT_RELR], { littleEndian: false });
  assert.equal(hasRelrSection(readerFor(bigEndian)), false);

  const empty = Buffer.alloc(0);
  assert.equal(hasRelrSection(readerFor(empty)), false);
});

test('the extended section count is declined rather than guessed at', () => {
  // e_shnum == 0 puts the real count in the first entry. No shared library has
  // 65280 sections, so this reads as "cannot tell", not as "no relr proven".
  const buffer = elf([SHT_RELR]);
  buffer.writeUInt16LE(0, 0x3c);
  assert.equal(hasRelrSection(readerFor(buffer)), false);
});

test('a file that cannot be opened answers no', () => {
  assert.equal(fileHasRelrSection('/nonexistent/libnothing.so.1'), false);
});

test('a host with no readable libraries to sample is not declared relr', () => {
  assert.equal(hostBuildsWithRelr([]), false);
});

test('a working patchelf reports no problem', () => {
  const problem = patchelfProblem(() => ({ status: 0, stdout: 'patchelf 0.18.0\n', stderr: '' }));
  assert.equal(problem, null);
});

test('a shim that cannot resolve patchelf is reported in its own words', () => {
  // What `pyenv` prints when the selected environment is not the one holding
  // the tool: on PATH, executable, and still exit 127.
  const problem = patchelfProblem(() => ({
    status: 127,
    stdout: '',
    stderr: 'pyenv: patchelf: command not found\n\nThe `patchelf` command exists in...\n',
  }));
  assert.equal(problem, 'pyenv: patchelf: command not found');
});

test('a patchelf that is absent entirely is reported', () => {
  const problem = patchelfProblem(() => ({ error: new Error('spawnSync patchelf ENOENT') }));
  assert.equal(problem, 'spawnSync patchelf ENOENT');
});

test('a silent failure still yields a message', () => {
  const problem = patchelfProblem(() => ({ status: 3, stdout: '', stderr: '' }));
  assert.equal(problem, 'exited with code 3');
});
