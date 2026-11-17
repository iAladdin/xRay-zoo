ALTER TABLE "Node" ADD COLUMN "resourceState" TEXT NOT NULL DEFAULT 'active', ADD COLUMN "activeLifecycleId" TEXT, ADD COLUMN "releasedAt" TIMESTAMP(3), ADD COLUMN "deploymentConfig" JSONB, ADD COLUMN "realityStateCipher" TEXT, ADD COLUMN "diskType" TEXT NOT NULL DEFAULT 'StandardSSD_LRS', ADD COLUMN "diskSizeGiB" INTEGER NOT NULL DEFAULT 32;
DROP INDEX "ProvisionOperation_nodeName_key";
DROP INDEX "ProvisionOperation_controlPort_key";
CREATE TABLE "NodeLifecycle" (
 "id" TEXT NOT NULL, "nodeId" TEXT NOT NULL, "actorId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
 "action" TEXT NOT NULL, "phase" TEXT NOT NULL DEFAULT 'queued', "status" TEXT NOT NULL DEFAULT 'running',
 "checkpoint" JSONB NOT NULL DEFAULT '{}', "machineId" TEXT, "events" JSONB NOT NULL DEFAULT '[]', "errorCode" TEXT,
 "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, "phaseStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3),
 CONSTRAINT "NodeLifecycle_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "NodeLifecycle_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NodeLifecycle_actorId_idempotencyKey_key" ON "NodeLifecycle"("actorId", "idempotencyKey");
CREATE UNIQUE INDEX "NodeLifecycle_machineId_key" ON "NodeLifecycle"("machineId");
CREATE INDEX "NodeLifecycle_status_leaseUntil_idx" ON "NodeLifecycle"("status", "leaseUntil");
CREATE INDEX "NodeLifecycle_nodeId_createdAt_idx" ON "NodeLifecycle"("nodeId", "createdAt");
