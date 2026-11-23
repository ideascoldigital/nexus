-- A bot's avatar is a shape + a color (spec 23).
ALTER TABLE "Bot" ADD COLUMN "shape" TEXT NOT NULL DEFAULT 'blob';
