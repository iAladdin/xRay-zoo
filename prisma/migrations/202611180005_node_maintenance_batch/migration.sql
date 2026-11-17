CREATE TABLE "NodeMaintenanceBatch" (
  "id" TEXT NOT NULL PRIMARY KEY, "actorId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL, "action" TEXT NOT NULL, "items" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running', "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "NodeMaintenanceBatch_actorId_idempotencyKey_key" ON "NodeMaintenanceBatch"("actorId", "idempotencyKey");
CREATE INDEX "NodeMaintenanceBatch_status_leaseUntil_idx" ON "NodeMaintenanceBatch"("status", "leaseUntil");
