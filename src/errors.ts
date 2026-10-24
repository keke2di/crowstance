/** Errors whose message should be shown to the assistant/user verbatim. */
export class UserError extends Error {}

/** A spending cap refused new work. The message says which cap and how to raise it. */
export class BudgetError extends UserError {}
