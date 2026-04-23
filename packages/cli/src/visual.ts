/**
 * @deprecated Import directly from brand.ts, color.ts, or layout.ts instead.
 *
 * This barrel re-exports everything from the three focused modules so that
 * existing importers continue to compile without changes. New code should
 * import from the specific module that owns each export.
 *
 * - brand.ts  — MARK, WORDMARK, SYMBOLS, flowHeader
 * - color.ts  — initColor, colorEnabled, colorMode, setColorDisabled,
 *               green, yellow, red, gray, bold, dim
 * - layout.ts — STEP_NAME_WIDTH, MODEL_WIDTH, DURATION_WIDTH,
 *               rule, header, footer, kvLine
 */

export {
  flowHeader,
  MARK,
  SYMBOLS,
  WORDMARK,
} from './brand.js';

export {
  bold,
  colorEnabled,
  colorMode,
  dim,
  gray,
  green,
  initColor,
  red,
  setColorDisabled,
  yellow,
} from './color.js';

export {
  DURATION_WIDTH,
  footer,
  header,
  kvLine,
  MODEL_WIDTH,
  rule,
  STEP_NAME_WIDTH,
} from './layout.js';
