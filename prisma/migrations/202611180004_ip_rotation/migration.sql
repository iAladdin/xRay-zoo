ALTER TABLE "Node" ADD COLUMN "activeIpRotationId" TEXT, ADD COLUMN "addressChanging" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProvisionPlan" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'machine';
CREATE TABLE "IpRotation" (
  "id" TEXT NOT NULL PRIMARY KEY, "nodeId" TEXT NOT NULL REFERENCES "Node"("id"),
  "planId" TEXT NOT NULL REFERENCES "ProvisionPlan"("id"), "actorId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL, "oldAddress" TEXT NOT NULL, "newAddress" TEXT,
  "phase" TEXT NOT NULL DEFAULT 'queued', "status" TEXT NOT NULL DEFAULT 'running',
  "checkpoint" JSONB NOT NULL DEFAULT '{}', "events" JSONB NOT NULL DEFAULT '[]', "errorCode" TEXT,
  "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "phaseStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "IpRotation_planId_key" ON "IpRotation"("planId");
CREATE UNIQUE INDEX "IpRotation_actorId_idempotencyKey_key" ON "IpRotation"("actorId","idempotencyKey");
CREATE INDEX "IpRotation_status_leaseUntil_idx" ON "IpRotation"("status","leaseUntil");
CREATE INDEX "IpRotation_nodeId_createdAt_idx" ON "IpRotation"("nodeId","createdAt");
