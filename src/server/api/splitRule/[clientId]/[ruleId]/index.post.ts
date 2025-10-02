import { ClientGetSchema } from '#db/repositories/client/types';
import {
  SplitRuleGetSchema,
  SplitRuleUpdateSchema,
} from '#db/repositories/splitRule/types';

export default definePermissionEventHandler(
  'clients',
  'update',
  async ({ event, checkPermissions }) => {
    const { clientId, ruleId } = await getValidatedRouterParams(
      event,
      validateZod(ClientGetSchema.merge(SplitRuleGetSchema), event)
    );

    const client = await Database.clients.get(clientId);
    checkPermissions(client);

    const data = await readValidatedBody(
      event,
      validateZod(SplitRuleUpdateSchema, event)
    );

    await Database.splitRules.update(ruleId, data);

    // Apply split tunneling configurations
    await SplitTunneling.applyAllConfigs();

    return { success: true };
  }
);
