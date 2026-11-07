/**
 * An expected problem whose message should be shown to Claude (and the user),
 * e.g. "task not found" or "repo not linked". Anything else is a real bug.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
