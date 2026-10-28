-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "StreamStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NgoApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "donors" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ngos" (
    "id" TEXT NOT NULL,
    "owner_address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ngos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streams" (
    "id" TEXT NOT NULL,
    "on_chain_id" BIGINT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "ngo_id" TEXT NOT NULL,
    "token_address" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "lastRate" TEXT,
    "balance" TEXT NOT NULL,
    "withdrawn" TEXT NOT NULL,
    "status" "StreamStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ngo_applications" (
    "id" TEXT NOT NULL,
    "owner_address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "website" TEXT,
    "contact_email" TEXT NOT NULL,
    "country" TEXT,
    "status" "NgoApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ngo_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_checkpoints" (
    "id" TEXT NOT NULL,
    "last_ledger" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_dead_letters" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "contract_id" TEXT,
    "error" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stream_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "stream_id" BIGINT,
    "ledger" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stream_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "donors_address_key" ON "donors"("address");

-- CreateIndex
CREATE UNIQUE INDEX "ngos_owner_address_key" ON "ngos"("owner_address");

-- CreateIndex
CREATE UNIQUE INDEX "streams_on_chain_id_key" ON "streams"("on_chain_id");

-- CreateIndex
CREATE INDEX "streams_donor_id_idx" ON "streams"("donor_id");

-- CreateIndex
CREATE INDEX "streams_ngo_id_idx" ON "streams"("ngo_id");

-- CreateIndex
CREATE INDEX "ngo_applications_owner_address_idx" ON "ngo_applications"("owner_address");

-- CreateIndex
CREATE INDEX "ngo_applications_status_idx" ON "ngo_applications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "indexer_dead_letters_event_id_key" ON "indexer_dead_letters"("event_id");

-- CreateIndex
CREATE INDEX "indexer_dead_letters_ledger_idx" ON "indexer_dead_letters"("ledger");

-- CreateIndex
CREATE INDEX "stream_events_stream_id_idx" ON "stream_events"("stream_id");

-- CreateIndex
CREATE INDEX "stream_events_type_idx" ON "stream_events"("type");

-- CreateIndex
CREATE INDEX "stream_events_ledger_idx" ON "stream_events"("ledger");

-- AddForeignKey
ALTER TABLE "streams" ADD CONSTRAINT "streams_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "donors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streams" ADD CONSTRAINT "streams_ngo_id_fkey" FOREIGN KEY ("ngo_id") REFERENCES "ngos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
