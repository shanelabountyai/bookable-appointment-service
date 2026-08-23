/**
 * The grid's vertical scale, in its own module because two components need the
 * NUMBER and one of them is a client component while the other is not
 * (`view-model.ts` is `server-only`). A room strip drawn at a different scale
 * from the columns it sits under is worse than no strip: the eye reads them as
 * one picture whether or not they line up.
 */
export const PX_PER_MINUTE = 1.5;
