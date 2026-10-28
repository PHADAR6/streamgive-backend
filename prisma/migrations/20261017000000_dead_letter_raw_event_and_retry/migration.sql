ALTER TABLE "indexer_dead_letters" ADD COLUMN "topic" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "indexer_dead_letters" ADD COLUMN "value" TEXT;
ALTER TABLE "indexer_dead_letters" ADD COLUMN "tx_hash" TEXT;
ALTER TABLE "indexer_dead_letters" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "indexer_dead_letters" ADD COLUMN "resolved_at" TIMESTAMP(3);
