export { prisma, databasePath } from "./client";
export {
  acquireInstanceLock,
  describeLockConflict,
  lockPathFor,
  type LockHolder,
  type LockResult,
} from "./instance-lock";
export * from "./generated/prisma/client";
