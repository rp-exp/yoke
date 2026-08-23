import type { HarnessId } from "../types.ts"

/** "skipped-tier" is a declared skip (tier-A case vs tier-B subject), never a silent one. */
export type CaseStatus = "pass" | "fail" | "skipped-tier"

export interface CaseResult {
  readonly name: string
  readonly status: CaseStatus
  /** Failure detail; present only when status is "fail". */
  readonly error?: string
}

export interface ConformanceReport {
  readonly harnessId: HarnessId
  readonly tier: "A" | "B"
  readonly results: readonly CaseResult[]
  /** True iff every executed case passed; skipped-tier cases don't count against. */
  readonly passed: boolean
}
