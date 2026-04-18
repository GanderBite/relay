import Handlebars from 'handlebars';
import { err, ok, type Result } from 'neverthrow';

import { FlowDefinitionError } from './errors.js';

const runtime = Handlebars.create();

// Missing variable or block helper references resolve to empty string instead of throwing.
runtime.registerHelper('helperMissing', () => '');
runtime.registerHelper('blockHelperMissing', () => '');

/**
 * Renders a Handlebars template against `vars`, returning the rendered string
 * on success or a FlowDefinitionError on parse/compile failure. Missing paths
 * produce empty string. Output is not HTML-escaped — it feeds Claude prompts.
 */
export function renderTemplate(
  tpl: string,
  vars: Record<string, unknown>,
): Result<string, FlowDefinitionError> {
  try {
    const compiled = runtime.compile(tpl, { strict: false, noEscape: true });
    return ok(compiled(vars));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return err(new FlowDefinitionError('template render failed: ' + message));
  }
}
