import { ClientGetSchema } from '#db/repositories/client/types';
import { SplitRuleGetSchema } from '#db/repositories/splitRule/types';

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

    await Database.splitRules.delete(ruleId);

    // Apply split tunneling configurations
    await SplitTunneling.applyAllConfigs();

    return { success: true };
  }
);
