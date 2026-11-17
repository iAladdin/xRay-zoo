ALTER TABLE "Plan" ADD COLUMN "globalPool" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "globalPool" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Subscription" ADD COLUMN "globalPool" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Node" ADD COLUMN "globalPool" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "publishedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "azureVmId" TEXT, ADD COLUMN "vmSize" TEXT,
  ADD COLUMN "controlPort" INTEGER, ADD COLUMN "operationId" TEXT;
CREATE UNIQUE INDEX "Node_controlPort_key" ON "Node"("controlPort");
CREATE UNIQUE INDEX "Node_operationId_key" ON "Node"("operationId");
UPDATE "Node" SET "globalPool" = true;
UPDATE "Plan" SET "globalPool" = true WHERE id IN ('p0-20gb','global-50gb','global-150gb','global-300gb');
UPDATE "Order" SET "globalPool" = true WHERE "planId" IN ('p0-20gb','global-50gb','global-150gb','global-300gb');
UPDATE "Subscription" SET "globalPool" = true WHERE "currentPeriodId" IN (SELECT p.id FROM "ServicePeriod" p JOIN "Order" o ON o.id=p."orderId" WHERE o."globalPool");
CREATE TABLE "ProvisionPlan" (
  "id" TEXT NOT NULL PRIMARY KEY, "actorId" TEXT NOT NULL, "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ProvisionOperation" (
  "id" TEXT NOT NULL PRIMARY KEY, "planId" TEXT NOT NULL REFERENCES "ProvisionPlan"("id"),
  "actorId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "nodeName" TEXT NOT NULL,
  "region" TEXT NOT NULL, "country" TEXT NOT NULL, "size" TEXT NOT NULL, "controlPort" INTEGER NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'queued', "status" TEXT NOT NULL DEFAULT 'running', "azureState" TEXT,
  "checkpoint" JSONB NOT NULL DEFAULT '{}', "privateState" TEXT, "errorCode" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 1, "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "phaseStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "ProvisionOperation_planId_key" ON "ProvisionOperation"("planId");
CREATE UNIQUE INDEX "ProvisionOperation_nodeName_key" ON "ProvisionOperation"("nodeName");
CREATE UNIQUE INDEX "ProvisionOperation_controlPort_key" ON "ProvisionOperation"("controlPort");
CREATE UNIQUE INDEX "ProvisionOperation_actorId_idempotencyKey_key" ON "ProvisionOperation"("actorId","idempotencyKey");
CREATE INDEX "ProvisionOperation_status_leaseUntil_idx" ON "ProvisionOperation"("status","leaseUntil");
CREATE TABLE "ProvisionEvent" (
  "id" TEXT NOT NULL PRIMARY KEY, "operationId" TEXT NOT NULL REFERENCES "ProvisionOperation"("id") ON DELETE RESTRICT,
  "phase" TEXT NOT NULL, "message" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ProvisionEvent_operationId_createdAt_idx" ON "ProvisionEvent"("operationId","createdAt");
