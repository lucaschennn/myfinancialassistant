// Money
export {
  type Cents,
  ZERO,
  dollarsToCents,
  dollarsToCentsOrNull,
  sumCents,
  absCents,
  ratioToBasisPoints,
  basisPointsToPercent,
  formatCents,
  parseAmount,
  type ParsedAmount,
  jsonReplacer,
  toJson,
} from './money.js';

// Presentation
export { humanize } from './present.js';

// Provenance & evidence
export {
  type Provenance,
  type ProvenanceSource,
  type ToolResult,
  type EvidenceEntry,
  type EvidenceBundle,
  type ReasoningTrace,
  EvidenceBuilder,
  result,
  toReasoningTrace,
} from './provenance.js';

// Session snapshot
export {
  type AccountType,
  type SessionSnapshot,
  type SnapshotAccount,
  type SnapshotGap,
  type SnapshotHolding,
  type SnapshotSecurity,
  type SnapshotTransaction,
  type TransactionCategory,
  type SourceKind,
  LIABILITY_TYPES,
  INVESTABLE_ASSET_TYPES,
  ILLIQUID_SECURED_LOAN_SUBTYPES,
  isIlliquidSecuredDebt,
  emptySnapshot,
  securityIndex,
  accountIndex,
  institutionNames,
  gapNotes,
  STALE_AFTER_DAYS,
  staleAccounts,
  staleBalanceNotes,
  balanceOriginNotes,
  sourcesOf,
  describeSources,
  obtainedVia,
} from './snapshot.js';

// Sources and the merge (Phase 2)
export {
  type SourceResult,
  mergeSources,
  transactionWindowFor,
  manualAccountId,
  manualSecurityId,
  isManualAccountId,
  manualUuid,
  DuplicateAccountIdError,
} from './sources.js';

// Network trace
export {
  type NetworkTrace,
  type TraceEntry,
  type TraceScope,
  EMPTY_TRACE,
  TraceRecorder,
} from './trace.js';

// Context
export {
  type Ctx,
  MissingSnapshotError,
  MissingDatabaseError,
  SnapshotOwnershipError,
  requireSnapshot,
  requireDb,
} from './context.js';

// Aggregation tools
export {
  listAccounts,
  getBalances,
  getHoldings,
  getTransactions,
  type AccountSummary,
  type ListAccountsData,
  type BalanceLine,
  type GetBalancesData,
  type GetHoldingsData,
  type GetTransactionsParams,
  type GetTransactionsData,
  type AccountFilterParams,
} from './tools/aggregation.js';

// Context tools
export {
  getProfile,
  getUserContext,
  setProfile,
  setGoal,
  deleteGoal,
  addNote,
  type ProfileData,
  type UserContextData,
  type SetProfileParams,
  type SetGoalParams,
} from './tools/userContext.js';

// User store
export {
  resolveUser,
  findUser,
  claimSeededUser,
  MissingAuthSubjectError,
  type ResolveUserParams,
  type ResolvedUser,
} from './tools/users.js';

// Derived aggregates
export {
  appendNetWorthSnapshot,
  getNetWorthHistory,
  type NetWorthSnapshotRow,
  type NetWorthHistoryData,
} from './tools/aggregates.js';

// Compute
export { netWorth, type NetWorthData, type NetWorthLine } from './compute/netWorth.js';
export {
  assetAllocation,
  type AssetAllocationData,
  type AssetAllocationParams,
  type AssetClass,
  type AllocationBucket,
  type AllocationHoldingLine,
} from './compute/assetAllocation.js';
export { fireProgress, type FireProgressData, type FireProgressParams } from './compute/fireProgress.js';
export { cashFlow, type CashFlowData, type CashFlowParams } from './compute/cashFlow.js';
export { savingsRate, type SavingsRateData, type SavingsRateParams } from './compute/savingsRate.js';
export {
  spendingByCategory,
  type SpendingByCategoryData,
  type SpendingByCategoryParams,
  type CategoryGroup,
  type CategoryDetailLine,
} from './compute/spendingByCategory.js';
export {
  type Period,
  type SelectOptions,
  assertPeriod,
  selectTransactions,
} from './compute/period.js';

// Agent loop support (pure pieces — the model calls live in the app)
export {
  checkAttribution,
  allowedFigures,
  attributionFailureMessage,
  type AttributionReport,
  type AttributionViolation,
} from './agent/attribution.js';
export {
  JOLLY_SYSTEM_PROMPT,
  evidencePayload,
  synthesisUserTurn,
  attributionRetryTurn,
  type SynthesisPromptParams,
} from './agent/prompt.js';
export {
  ROUTER_SCHEMA,
  ROUTER_SYSTEM_PROMPT,
  FALLBACK_DECISION,
  resolvePeriod,
  isRouterDecision,
  type RouterDecision,
  type RelativePeriod,
} from './agent/router.js';

// Workflows
export {
  runWorkflow,
  summaryOverview,
  implementedWorkflows,
  UnknownWorkflowError,
  type Limitation,
  type Workflow,
  type WorkflowName,
  type WorkflowParams,
  type WorkflowRun,
} from './workflows/index.js';

// Manual ledger — typed entry (Phase 2). Document imports live in @pfg/ingest.
export {
  ACCOUNT_TYPES,
  ManualLedgerError,
  assertBalanceDate,
  createManualAccount,
  recordManualBalance,
  archiveManualAccount,
  getManualBalanceHistory,
  type CreateManualAccountParams,
  type ManualAccountCreated,
  type ManualBalancePoint,
} from './tools/manualLedger.js';
