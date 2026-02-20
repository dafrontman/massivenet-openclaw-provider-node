import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createMassiveNetProviderNodeService } from "./src/service.js";

const plugin: {
  id: string;
  name: string;
  description: string;
  configSchema: ReturnType<typeof emptyPluginConfigSchema>;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: "massivenet_provider_node",
  name: "MassiveNet Provider Node",
  description: "Runs a MassiveNet provider-node polling worker inside OpenClaw.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(createMassiveNetProviderNodeService());
  },
};

export default plugin;
