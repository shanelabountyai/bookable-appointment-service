-- A-152 (C11, D-75): when "End this series here" (D-39) last ended this series.
-- The "series ending soon" list skips ended series: a series the desk ended on
-- purpose is not one quietly running out.
ALTER TABLE "AppointmentSeries" ADD COLUMN "endedAt" TIMESTAMPTZ(3);
