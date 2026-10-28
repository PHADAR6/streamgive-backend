ALTER TABLE "ngo_applications" ADD COLUMN "email_verified_at" TIMESTAMP(3);

CREATE TABLE "ngo_application_contact_challenges" (
    "token_hash" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ngo_application_contact_challenges_pkey" PRIMARY KEY ("token_hash")
);

CREATE UNIQUE INDEX "ngo_application_contact_challenges_application_id_key"
    ON "ngo_application_contact_challenges"("application_id");
CREATE INDEX "ngo_application_contact_challenges_expires_at_idx"
    ON "ngo_application_contact_challenges"("expires_at");
ALTER TABLE "ngo_application_contact_challenges"
    ADD CONSTRAINT "ngo_application_contact_challenges_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "ngo_applications"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
