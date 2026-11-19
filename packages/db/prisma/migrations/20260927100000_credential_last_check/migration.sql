-- CloudCredential.lastCheck / lastCheckedAt: the last Test result (spec 28),
-- stored so the credentials list shows a status without re-checking.
ALTER TABLE "CloudCredential" ADD COLUMN "lastCheck" JSONB;
ALTER TABLE "CloudCredential" ADD COLUMN "lastCheckedAt" DATETIME;
