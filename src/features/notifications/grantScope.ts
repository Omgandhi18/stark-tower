/** Where an "always allow" rule applies: this task, this project or every project. */
export type GrantScope = "task" | "project" | "everywhere";

/** The decision that grants a rule where it applies. */
export const grantDecision = (scope: GrantScope) =>
  scope === "task" ? "Allow for task" : scope === "project" ? "Allow in project" : "Allow everywhere";
