// Entry point that never touches the Prisma client: importing "@nexux/db"
// constructs it, and construction migrates. The server takes the instance
// lock through here first, so a second server cannot change the schema under
// a running one before being refused.
export { databasePath } from "./db-path";
export {
  acquireInstanceLock,
  describeLockConflict,
  lockPathFor,
  type LockHolder,
  type LockResult,
} from "./instance-lock";
