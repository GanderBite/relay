#!/usr/bin/env node
// Usage: node scripts/bump-version.mjs [patch|minor|major|<x.y.z>]
//
// Bumps the version of every publishable package in lockstep, updates
// relay-core peer-dep constraints in generator templates and flow packages,
// then commits. Push to main to trigger npm-publish.yml.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function bump(current, type) {
  const [maj, min, pat] = current.split('.').map(Number);
  switch (type) {
    case 'major': return `${maj + 1}.0.0`;
    case 'minor': return `${maj}.${min + 1}.0`;
    case 'patch': return `${maj}.${min}.${pat + 1}`;
    default:
      if (/^\d+\.\d+\.\d+$/.test(type)) return type;
      throw new Error(`unknown bump type: ${type} (use patch | minor | major | x.y.z)`);
  }
}

const bumpType = process.argv[2] ?? 'patch';

const corePkg = readJson('packages/core/package.json');
const prev = corePkg.version;
const next = bump(prev, bumpType);

console.log(`  ${prev} → ${next}`);

// ── publishable packages ──────────────────────────────────────────────────────
const publishable = [
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/generator/package.json',
];

for (const p of publishable) {
  const pkg = readJson(p);
  pkg.version = next;
  writeJson(p, pkg);
}

// ── peer-dep constraints in templates + flows ─────────────────────────────────
// Only update when major or minor changes; patch bumps stay within ^x.y.0.
const [prevMaj, prevMin] = prev.split('.').map(Number);
const [nextMaj, nextMin] = next.split('.').map(Number);

const peerFiles = [
  'packages/generator/templates/blank/package.json',
  'packages/generator/templates/linear/package.json',
  'packages/generator/templates/fan-out/package.json',
  'packages/generator/templates/discovery/package.json',
  'packages/flows/codebase-discovery/package.json',
  'packages/flows/onboarding-guide/package.json',
  'packages/flows/release-notes/package.json',
  'packages/flows/spec-generator/package.json',
];

if (nextMaj !== prevMaj || nextMin !== prevMin) {
  const constraint = `^${nextMaj}.${nextMin}.0`;
  for (const p of peerFiles) {
    const pkg = readJson(p);
    if (pkg.peerDependencies?.['@ganderbite/relay-core']) {
      pkg.peerDependencies['@ganderbite/relay-core'] = constraint;
      writeJson(p, pkg);
    }
  }
  console.log(`  relay-core peer dep → ${constraint}`);
}

// ── commit ────────────────────────────────────────────────────────────────────
const allChanged = [...publishable, ...(nextMaj !== prevMaj || nextMin !== prevMin ? peerFiles : [])];
execSync(`git add ${allChanged.join(' ')}`, { stdio: 'inherit' });
execSync(`git commit -m "chore: release v${next}"`, { stdio: 'inherit' });

console.log(`\n  committed — push to main to publish`);
