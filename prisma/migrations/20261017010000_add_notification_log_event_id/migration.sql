-- AlterTable
ALTER TABLE "notification_logs" ADD COLUMN "event_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "notification_logs_event_id_channel_key" ON "notification_logs"("event_id", "channel");
