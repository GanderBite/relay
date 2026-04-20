import { pickTemplate, scaffoldFlow, type TemplateId } from './scaffold.js';

const VALID_TEMPLATES: ReadonlyArray<TemplateId> = ['blank', 'linear', 'fan-out', 'discovery'];

function isTemplateId(value: string): value is TemplateId {
  return (VALID_TEMPLATES as ReadonlyArray<string>).includes(value);
}

function parseArgs(argv: string[]): {
  template: TemplateId | undefined;
  outDir: string | undefined;
  tokens: Record<string, string>;
  force: boolean;
} {
  const tokens: Record<string, string> = {};
  let template: TemplateId | undefined;
  let outDir: string | undefined;
  let force = false;

  const args = argv.slice(2);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--template' && i + 1 < args.length) {
      const val = args[i + 1] ?? '';
      if (!isTemplateId(val)) {
        process.stderr.write(`scaffold: unknown template: ${val} (choose: blank, linear, fan-out, discovery)\n`);
        process.exit(1);
      }
      template = val;
      i += 2;
    } else if (arg === '--out' && i + 1 < args.length) {
      outDir = args[i + 1];
      i += 2;
    } else if (arg === '--token' && i + 1 < args.length) {
      const pair = args[i + 1] ?? '';
      const eqIdx = pair.indexOf('=');
      if (eqIdx !== -1) {
        const key = pair.slice(0, eqIdx);
        const value = pair.slice(eqIdx + 1);
        tokens[key] = value;
      }
      i += 2;
    } else if (arg === '--intent' && i + 1 < args.length) {
      const intent = args[i + 1] ?? '';
      if (template === undefined) {
        template = pickTemplate(intent);
      }
      i += 2;
    } else if (arg === '--force') {
      force = true;
      i += 1;
    } else {
      i += 1;
    }
  }

  return { template, outDir, tokens, force };
}

async function main(): Promise<void> {
  const { template, outDir, tokens, force } = parseArgs(process.argv);

  if (template === undefined) {
    process.stderr.write('scaffold: --template is required (blank | linear | fan-out | discovery)\n');
    process.exit(1);
  }

  if (outDir === undefined) {
    process.stderr.write('scaffold: --out is required\n');
    process.exit(1);
  }

  const result = await scaffoldFlow({ template, outDir, tokens, force });

  if (result.isErr()) {
    const e = result.error;
    if (e.kind === 'template-not-found') {
      process.stderr.write(`scaffold: template not found: ${e.template}\n`);
    } else if (e.kind === 'file-exists') {
      process.stderr.write(`scaffold: file already exists: ${e.path}\n`);
      process.stderr.write('scaffold: pass --force to overwrite\n');
    } else if (e.kind === 'missing-token') {
      process.stderr.write(`scaffold: missing token ${e.token} in ${e.path}\n`);
    } else {
      const msg = e.cause instanceof Error ? e.cause.message : String(e.cause);
      process.stderr.write(`scaffold: i/o error: ${msg}\n`);
    }
    process.exit(1);
  }

  const { filesWritten } = result.value;
  for (const f of filesWritten) {
    process.stdout.write(`  ✓ ${f}\n`);
  }
  process.stdout.write(`\nscaffold: wrote ${filesWritten.length} file(s) to ${outDir}\n`);
}

await main();
