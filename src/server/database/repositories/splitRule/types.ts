import type { InferSelectModel } from 'drizzle-orm';
import z from 'zod';
import type { splitRule } from './schema';

export type SplitRuleType = InferSelectModel<typeof splitRule>;

export type CreateSplitRuleType = Omit<
  SplitRuleType,
  'id' | 'createdAt' | 'updatedAt'
>;

export type UpdateSplitRuleType = Partial<
  Omit<CreateSplitRuleType, 'clientId'>
>;

const ruleType = z.enum(['domain', 'ip'], {
  message: t('zod.splitRule.ruleType'),
});

const ruleValue = z
  .string({ message: t('zod.splitRule.ruleValue') })
  .min(1, t('zod.splitRule.ruleValue'))
  .pipe(safeStringRefine);

const action = z
  .enum(['proxy', 'direct'], { message: t('zod.splitRule.action') })
  .default('proxy');

export const SplitRuleCreateSchema = z.object({
  ruleType: ruleType,
  ruleValue: ruleValue,
  action: action,
  enabled: EnabledSchema.default(true),
});

export const SplitRuleUpdateSchema = z.object({
  ruleType: ruleType.optional(),
  ruleValue: ruleValue.optional(),
  action: action.optional(),
  enabled: EnabledSchema.optional(),
});

const ruleId = z.coerce.number({ message: t('zod.splitRule.id') });

export const SplitRuleGetSchema = z.object({
  ruleId: ruleId,
});
