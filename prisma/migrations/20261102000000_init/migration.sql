-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ExtractType" AS ENUM ('TEXT', 'ATTRIBUTE');

-- CreateEnum
CREATE TYPE "FieldRole" AS ENUM ('TEXT', 'PRICE', 'STOCK', 'QUANTITY');

-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('IN_STOCK', 'OUT_OF_STOCK', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FieldStatus" AS ENUM ('OK', 'MISSING', 'INVALID_SELECTOR');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('SUCCESS', 'PARTIAL', 'ERROR');

-- CreateTable
CREATE TABLE "Monitor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 60,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastRunStatus" "RunStatus",
    "lastStockStatus" "StockStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Monitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorField" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "selector" TEXT NOT NULL,
    "extractType" "ExtractType" NOT NULL DEFAULT 'TEXT',
    "attribute" TEXT,
    "role" "FieldRole" NOT NULL DEFAULT 'TEXT',
    "inStockTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outOfStockTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "lastValue" TEXT,
    "lastNumeric" DECIMAL(18,4),
    "lastStatus" "FieldStatus",
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitorField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckRun" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "status" "RunStatus" NOT NULL,
    "changed" BOOLEAN NOT NULL DEFAULT false,
    "stockStatus" "StockStatus" NOT NULL DEFAULT 'UNKNOWN',
    "previousStockStatus" "StockStatus" NOT NULL DEFAULT 'UNKNOWN',
    "errorCode" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "CheckRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldResult" (
    "id" TEXT NOT NULL,
    "checkRunId" TEXT NOT NULL,
    "fieldId" TEXT,
    "fieldName" TEXT NOT NULL,
    "role" "FieldRole" NOT NULL,
    "status" "FieldStatus" NOT NULL,
    "previousValue" TEXT,
    "currentValue" TEXT,
    "changed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "FieldResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Monitor_enabled_nextCheckAt_idx" ON "Monitor"("enabled", "nextCheckAt");

-- CreateIndex
CREATE INDEX "MonitorField_monitorId_position_idx" ON "MonitorField"("monitorId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MonitorField_monitorId_name_key" ON "MonitorField"("monitorId", "name");

-- CreateIndex
CREATE INDEX "CheckRun_monitorId_startedAt_idx" ON "CheckRun"("monitorId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "CheckRun_startedAt_idx" ON "CheckRun"("startedAt" DESC);

-- CreateIndex
CREATE INDEX "CheckRun_status_startedAt_idx" ON "CheckRun"("status", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "CheckRun_changed_startedAt_idx" ON "CheckRun"("changed", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "FieldResult_checkRunId_idx" ON "FieldResult"("checkRunId");

-- CreateIndex
CREATE INDEX "FieldResult_fieldId_idx" ON "FieldResult"("fieldId");

-- AddForeignKey
ALTER TABLE "MonitorField" ADD CONSTRAINT "MonitorField_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckRun" ADD CONSTRAINT "CheckRun_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldResult" ADD CONSTRAINT "FieldResult_checkRunId_fkey" FOREIGN KEY ("checkRunId") REFERENCES "CheckRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldResult" ADD CONSTRAINT "FieldResult_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "MonitorField"("id") ON DELETE SET NULL ON UPDATE CASCADE;

