export * from "./contract.js";
export {
  loadReapConfig,
  REAP_VERSION,
  ReapConfigError,
  type ManagedReapWrapper,
  type ReapConfig,
  type ReapWrapperOptions,
  type UserBinding,
} from "./config.js";
import { createReapWrapperInternal } from "./wrapper.js";
import { createDemoReapWrapper } from "./demo.js";
import type { ManagedReapWrapper, ReapWrapperOptions } from "./config.js";

export function createReapWrapper(options: ReapWrapperOptions): ManagedReapWrapper {
  return createReapWrapperInternal(options);
}

export { createDemoReapWrapper };
export { createReapWithMockUsers } from './mock-users.js';
export { createReapOrchestrationPorts, type ReapOrchestrationOptions } from './orchestration.js';
