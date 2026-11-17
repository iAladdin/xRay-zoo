ALTER TABLE "Node"
ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "engineConnected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "engineDisabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "transportConnected" BOOLEAN,
ADD COLUMN "healthReason" TEXT NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "lastHealthyAt" TIMESTAMP(3),
ADD COLUMN "usageBytes" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "usageUpdatedAt" TIMESTAMP(3),
ADD COLUMN "xrayVersion" TEXT,
ADD COLUMN "controlLeaseOwner" TEXT,
ADD COLUMN "controlLeaseUntil" TIMESTAMP(3);
CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL, "actorId" TEXT NOT NULL, "action" TEXT NOT NULL,
  "targetId" TEXT NOT NULL, "detail" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
