import type { Router } from 'express';
export interface ModuleDef {
  /** Mounted at /api/<path> */
  path: string;
  router: Router;
  /** Register approval handlers, sync hooks, jobs and file-access rules. Runs once at start-up. */
  init?: () => void;
  /**
   * Create this module's platform-owned demo records on an empty database. Runs after the base
   * seed (masters + SAP simulator documents synced into the platform), in MODULES order.
   * Use the helpers in server/seed/ctx.ts and the module's own service functions.
   */
  seed?: () => void;
}
