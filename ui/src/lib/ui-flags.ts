/**
 * Product UI feature flags.
 *
 * These are compile-time constants that gate presentation-only surfaces. They
 * deliberately do NOT touch the data model, API, validation, or filter DSL — a
 * gated feature stays fully functional at the data layer and can be revived by
 * flipping the flag back to `true`.
 */

/**
 * Controls whether task/issue **priority** indicators and controls are shown in
 * the product UI.
 *
 * Revived for the P0–P3 hotfix lane. API values stay critical/high/medium/low;
 * the UI labels them P0–P3. Flip back to `false` only if the board wants the
 * PAP-411 hide again.
 *
 * Typed as `boolean` (not a literal) so gated branches stay type-checkable.
 */
export const SHOW_TASK_PRIORITY_UI: boolean = true;
