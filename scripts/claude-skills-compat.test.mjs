import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const claudeSkills = path.join(repositoryRoot, '.claude', 'skills');
const agentsGuidance = path.join(repositoryRoot, 'AGENTS.md');

test('AGENTS.md routes Codex to every Claude Code skill', async () => {
  const [entries, guidance] = await Promise.all([
    readdir(claudeSkills, { withFileTypes: true }),
    readFile(agentsGuidance, 'utf8'),
  ]);

  for (const entry of entries.filter((entry) => entry.isDirectory())) {
    assert.match(
      guidance,
      new RegExp(`\\.claude/skills/${entry.name.replaceAll('-', '\\-')}/SKILL\\.md`),
      `${entry.name} is missing from the Codex skill index`,
    );
  }

  assert.match(
    guidance,
    /\.claude\/commands\/create-adr\.md/,
    'the project-native ADR command is missing from Codex guidance',
  );
});
