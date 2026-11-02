/** One run of a Kinroot background job, as handlers see it (from the platform's `JobInfo`). */
export type JobRun = {
  /** The platform's job id: the same on every try of one job. */
  id: string;
  /** This try, from 1. */
  attempts: number;
  /** Tries this job gets in all (its list's `retries` + 1, background.json). */
  maxAttempts: number;
};
