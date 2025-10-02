import { ClientGetSchema } from '#db/repositories/client/types';
import { SplitRuleCreateSchema } from '#db/repositories/splitRule/types';

export default definePermissionEventHandler(
  'clients',
  'update',
  async ({ event, checkPermissions }) => {
    const { clientId } = await getValidatedRouterParams(
      event,
      validateZod(ClientGetSchema, event)
    );

    const client = await Database.clients.get(clientId);
    checkPermissions(client);

    const data = await readValidatedBody(
      event,
      validateZod(SplitRuleCreateSchema, event)
    );

    const result = await Database.splitRules.create({
      ...data,
      clientId,
    });

    // Apply split tunneling configurations
    await SplitTunneling.applyAllConfigs();

    return {
      success: true,
      ruleId: result[0]!.id,
    };
  }
);
