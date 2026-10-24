ALTER TABLE "streams" RENAME COLUMN "lastRate" TO "last_rate";

CREATE TABLE "ngo_application_challenges" (
    "challenge" TEXT NOT NULL,
    "owner_address" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ngo_application_challenges_pkey" PRIMARY KEY ("challenge")
);

CREATE INDEX "ngo_application_challenges_owner_address_expires_at_idx"
    ON "ngo_application_challenges"("owner_address", "expires_at");
