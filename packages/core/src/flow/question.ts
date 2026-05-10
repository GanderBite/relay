import { z } from '../zod.js';

const TextQuestionSchema = z.strictObject({
  id: z.string(),
  kind: z.literal('text'),
  label: z.string(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
});

const MultilineQuestionSchema = z.strictObject({
  id: z.string(),
  kind: z.literal('multiline'),
  label: z.string(),
  required: z.boolean().optional(),
});

const SelectQuestionSchema = z.strictObject({
  id: z.string(),
  kind: z.literal('select'),
  label: z.string(),
  options: z.array(z.string()),
  required: z.boolean().optional(),
});

const MultiselectQuestionSchema = z.strictObject({
  id: z.string(),
  kind: z.literal('multiselect'),
  label: z.string(),
  options: z.array(z.string()),
  min: z.number().optional(),
  max: z.number().optional(),
});

const ConfirmQuestionSchema = z.strictObject({
  id: z.string(),
  kind: z.literal('confirm'),
  label: z.string(),
  default: z.boolean().optional(),
});

const NumberQuestionSchema = z.strictObject({
  id: z.string(),
  kind: z.literal('number'),
  label: z.string(),
  min: z.number().optional(),
  max: z.number().optional(),
  required: z.boolean().optional(),
});

export const QuestionSchema = z.discriminatedUnion('kind', [
  TextQuestionSchema,
  MultilineQuestionSchema,
  SelectQuestionSchema,
  MultiselectQuestionSchema,
  ConfirmQuestionSchema,
  NumberQuestionSchema,
]);

export const QuestionsArraySchema = z.array(QuestionSchema);

export const DynamicQuestionSourceSchema = z.object({ from: z.string() });

export type QuestionKind = 'text' | 'multiline' | 'select' | 'multiselect' | 'confirm' | 'number';

export type TextQuestion = z.infer<typeof TextQuestionSchema>;
export type MultilineQuestion = z.infer<typeof MultilineQuestionSchema>;
export type SelectQuestion = z.infer<typeof SelectQuestionSchema>;
export type MultiselectQuestion = z.infer<typeof MultiselectQuestionSchema>;
export type ConfirmQuestion = z.infer<typeof ConfirmQuestionSchema>;
export type NumberQuestion = z.infer<typeof NumberQuestionSchema>;

export type Question = z.infer<typeof QuestionSchema>;

export type DynamicQuestionSource = z.infer<typeof DynamicQuestionSourceSchema>;

export type AnswerMap = Record<string, unknown>;
