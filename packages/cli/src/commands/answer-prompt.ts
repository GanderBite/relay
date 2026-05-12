/**
 * answer-prompt.ts — interactive question prompting for `relay answer`.
 *
 * Extracted to keep answer.ts under the 400-line file cap.
 */

import { createInterface } from 'node:readline';
import type { AnswerMap, Question } from '@ganderbite/relay-core';
import { SYMBOLS } from '../brand.js';
import { gray } from '../color.js';

// ---------------------------------------------------------------------------
// Readline factory
// ---------------------------------------------------------------------------

export function makeReadline(): ReturnType<typeof createInterface> {
  return createInterface({ input: process.stdin, output: process.stdout });
}

// ---------------------------------------------------------------------------
// Prompt primitives
// ---------------------------------------------------------------------------

export async function promptText(
  rl: ReturnType<typeof createInterface>,
  label: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${SYMBOLS.dot} ${label}: `, (answer) => resolve(answer));
  });
}

export async function askQuestion(
  rl: ReturnType<typeof createInterface>,
  q: Question,
): Promise<unknown> {
  switch (q.kind) {
    case 'text':
    case 'multiline': {
      const raw = await promptText(rl, q.label);
      return raw;
    }

    case 'number': {
      let val: number;
      for (;;) {
        const raw = await promptText(rl, q.label);
        const n = Number(raw.trim());
        if (!Number.isFinite(n)) {
          process.stdout.write(gray(`  enter a number\n`));
          continue;
        }
        if (q.kind === 'number' && q.min !== undefined && n < q.min) {
          process.stdout.write(gray(`  minimum is ${q.min}\n`));
          continue;
        }
        if (q.kind === 'number' && q.max !== undefined && n > q.max) {
          process.stdout.write(gray(`  maximum is ${q.max}\n`));
          continue;
        }
        val = n;
        break;
      }
      return val;
    }

    case 'confirm': {
      const defaultStr = q.default === true ? 'Y/n' : q.default === false ? 'y/N' : 'y/n';
      const raw = await promptText(rl, `${q.label} (${defaultStr})`);
      const trimmed = raw.trim().toLowerCase();
      if (trimmed === '') {
        return q.default ?? false;
      }
      return trimmed === 'y' || trimmed === 'yes';
    }

    case 'select': {
      process.stdout.write(`${SYMBOLS.dot} ${q.label}\n`);
      q.options.forEach((opt, i) => {
        process.stdout.write(`    ${i + 1}. ${opt}\n`);
      });
      for (;;) {
        const raw = await promptText(rl, `select 1-${q.options.length}`);
        const n = parseInt(raw.trim(), 10);
        if (Number.isNaN(n) || n < 1 || n > q.options.length) {
          process.stdout.write(gray(`  enter a number between 1 and ${q.options.length}\n`));
          continue;
        }
        return q.options[n - 1];
      }
    }

    case 'multiselect': {
      process.stdout.write(`${SYMBOLS.dot} ${q.label}\n`);
      q.options.forEach((opt, i) => {
        process.stdout.write(`    ${i + 1}. ${opt}\n`);
      });
      const minDesc = q.min !== undefined ? `, min ${q.min}` : '';
      const maxDesc = q.max !== undefined ? `, max ${q.max}` : '';
      for (;;) {
        const raw = await promptText(rl, `select (comma-separated indices${minDesc}${maxDesc})`);
        const parts = raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const indices = parts.map((s) => parseInt(s, 10));
        if (indices.some((n) => Number.isNaN(n) || n < 1 || n > q.options.length)) {
          process.stdout.write(
            gray(`  enter comma-separated numbers between 1 and ${q.options.length}\n`),
          );
          continue;
        }
        if (q.min !== undefined && indices.length < q.min) {
          process.stdout.write(gray(`  select at least ${q.min}\n`));
          continue;
        }
        if (q.max !== undefined && indices.length > q.max) {
          process.stdout.write(gray(`  select at most ${q.max}\n`));
          continue;
        }
        return indices.map((n) => q.options[n - 1]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function collectMissingRequired(questions: Question[], answers: AnswerMap): string[] {
  const missing: string[] = [];
  for (const q of questions) {
    if (q.kind === 'confirm' || q.kind === 'multiselect') continue;
    const required = 'required' in q ? q.required : undefined;
    if (required !== true) continue;
    const val = answers[q.id];
    if (val === undefined || val === null || val === '') {
      missing.push(q.id);
    }
  }
  return missing;
}
