-- AlterTable
ALTER TABLE "AdHocBlock" ADD COLUMN     "actorRef" TEXT,
ADD COLUMN     "createdByActor" "Actor" DEFAULT 'staff';

-- AlterTable
ALTER TABLE "DateOverride" ADD COLUMN     "actorRef" TEXT,
ADD COLUMN     "createdByActor" "Actor" DEFAULT 'staff';

-- AlterTable
ALTER TABLE "TimeOff" ADD COLUMN     "actorRef" TEXT,
ADD COLUMN     "createdByActor" "Actor" DEFAULT 'staff';

-- AlterTable
ALTER TABLE "WeeklyWindow" ADD COLUMN     "actorRef" TEXT,
ADD COLUMN     "createdByActor" "Actor" DEFAULT 'staff';
