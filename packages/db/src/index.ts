export { ensureVault, prisma } from "./client";
export { isSealed, openString, sealString, vaultKeySource } from "./vault";
export type { VaultReport } from "./vault-admin";
export { databasePath } from "./db-path";
export {
  acquireInstanceLock,
  describeLockConflict,
  lockPathFor,
  type LockHolder,
  type LockResult,
} from "./instance-lock";
export * from "./generated/prisma/client";
