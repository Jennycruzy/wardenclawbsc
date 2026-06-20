/**
 * Deterministic, configurable risk parameters.
 *
 * These are the values the risk engine enforces at execution time. They can be
 * configured (via env / strategy JSON) but are non-negotiable once a mandate is
 * evaluated — the LLM cannot bypass them. Defaults target a micro-capital spot-only book
 * on the verified BNB competition rules.
 */

export interface RiskConfig {
  // Capital & sizing
  startingCapitalUsd: number;
  gasReserveUsd: number; // native BNB for gas only — not portfolio capital
  maxConcurrentPositions: number;
  perTradeRiskPct: number; // volatility-stop-derived sizing
  stopAtrMultiple: number;
  breakevenTriggerAtr: number; // gain (in ATR) that arms the breakeven+fees ratchet
  trailAtrMultiple: number; // normal trail distance below HWM (in ATR)
  trailTightAtrMultiple: number; // tight (defend/red) trail distance below HWM (in ATR)
  maxPositionPct: number;
  attackNotionalMinUsd: number;
  microScoutUsd: number; // stable↔stable compliance trade

  // Fast position-watch loop (protection cadence, only while a position is open)
  positionWatchIntervalSeconds: number;
  watchStalenessLimitSeconds: number;
  watchStalenessAction: "alert_only" | "reduce";

  // Entry quality — catalyst uncrowding + RS continuation
  trendingDeltaMin: number;
  trendingTopN: number;
  volumeExpansionMin: number;
  spikeCooldownChecks: number;
  maxRetracePct: number;
  spikeMinPct: number;
  rsOutperformMinBps: number;

  // Trade frequency (verified minimum: 1/day, 7/week)
  minTradesPerDay: number;
  targetTradesPerDay: number;
  maxTradesPerDay: number;

  // Week-schedule risk budget (HUNT/PRESS/DEFEND, leg-counting, win-first sizing)
  weeklyLegBudget: number;
  flatBandLoPct: number;
  flatBandHiPct: number;
  defendTriggerPct: number;
  huntMinScore: number;
  pressMinScore: number;
  defendMinScore: number;
  netEdgeDefendBonusBps: number;
  pressStartDay: number;

  // Red-day regime analyst (GREEN/NEUTRAL/RED with hysteresis)
  redBenchmarkPct: number;
  greenBenchmarkPct: number;
  redFearGreed: number;
  greenFearGreed: number;
  redBreadth: number;
  greenBreadth: number;
  regimeHysteresisChecks: number;
  regimeHighVolatilityRatio: number;

  // Drawdown / survival — three layers
  competitionDqDrawdownPct: number; // disqualifier; 30% indicative, confirm with organizer
  internalWindowDrawdownPct: number; // the offense's actual risk budget
  maxDailyDrawdownPct: number;
  softDrawdownPct: number;
  survivalLossStreak: number; // consecutive realized losses that pause new directional entries
  competitionFloorUsd: number; // verified $1 hourly zeroing rule
  dangerPortfolioValueUsd: number;

  // Micro-capital economics + calibration
  netEdgeMinBps: number;
  frictionBudgetBps: number;
  scoringSimCostBps: number; // per trade leg — internal safety assumption until confirmed
  twakFeeBps: number; // TWAK swap fee per leg — 7.7 (0.077%) waived rate during the trading week
  walletFloorFraction: number; // expected move must exceed this × measured real round-trip
  dustRoundTripCeilingBps: number; // measured real round-trip above this = dust (notional too small vs fixed cost)
  maxSlippageBps: number;
  // Buffer added on top of the modeled price impact to form the swap's slippage
  // TOLERANCE (the min-out bound TWAK signs against). The modeled impact is tiny for
  // small trades, so without this the tolerance rounds to ~0 and swaps revert on any
  // block-to-block movement. Capped by maxSlippageBps. This is execution safety only;
  // it does NOT affect the profitability/net-edge gate (which uses modeled friction).
  swapSlippageBufferBps: number;
  // Forced safety EXITS (stop/trail/regime/danger) may slip more than entries:
  // a protective exit that can't fill is worse than one that fills with slippage.
  // Entries stay capped at maxSlippageBps; only exits use this wider ceiling.
  exitMaxSlippageBps: number;
  shadowFillToleranceBps: number;
  kellyFraction: number;
  calibrationMaxAgeDays: number;

  // Approval safety
  allowInfiniteApprovals: boolean;
  approvalBufferBps: number;
}

/** Runtime defaults. Values tied to unresolved organizer details are safety assumptions. */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  startingCapitalUsd: 40,
  gasReserveUsd: 2,
  maxConcurrentPositions: 1,
  perTradeRiskPct: 3,
  stopAtrMultiple: 1.5,
  breakevenTriggerAtr: 1.5, // win-first: let a runner breathe before the stop snaps to breakeven (fewer churn-at-breakeven exits on a ~1.37% round-trip)
  trailAtrMultiple: 1.5,
  trailTightAtrMultiple: 1.0,
  maxPositionPct: 70,
  attackNotionalMinUsd: 15,
  microScoutUsd: 5,

  positionWatchIntervalSeconds: 45,
  watchStalenessLimitSeconds: 180,
  watchStalenessAction: "alert_only",

  trendingDeltaMin: 5,
  trendingTopN: 30,
  volumeExpansionMin: 1.5,
  spikeCooldownChecks: 2,
  maxRetracePct: 0.5,
  spikeMinPct: 0.08,
  rsOutperformMinBps: 200,

  minTradesPerDay: 1,
  targetTradesPerDay: 2,
  maxTradesPerDay: 3,

  weeklyLegBudget: 14,
  flatBandLoPct: -2,
  flatBandHiPct: 3,
  defendTriggerPct: 25, // win-first: stay in full-aggression HUNT until a strong lead before protecting
  huntMinScore: 80,
  pressMinScore: 65,
  defendMinScore: 90,
  netEdgeDefendBonusBps: 50,
  pressStartDay: 6,

  redBenchmarkPct: -4,
  greenBenchmarkPct: 2,
  redFearGreed: 25,
  greenFearGreed: 60,
  redBreadth: 0.3,
  greenBreadth: 0.6,
  regimeHysteresisChecks: 2,
  regimeHighVolatilityRatio: 1.5,

  competitionDqDrawdownPct: 30, // internal safety assumption; organizer threshold still pending
  internalWindowDrawdownPct: 15,
  maxDailyDrawdownPct: 6,
  softDrawdownPct: 4,
  survivalLossStreak: 2,
  competitionFloorUsd: 1.0,
  dangerPortfolioValueUsd: 8,

  netEdgeMinBps: 30,
  frictionBudgetBps: 120,
  scoringSimCostBps: 10, // internal scoring assumption; organizer model still pending
  twakFeeBps: 7.7,
  walletFloorFraction: 0.75,
  dustRoundTripCeilingBps: 350,
  maxSlippageBps: 50,
  swapSlippageBufferBps: 25,
  exitMaxSlippageBps: 250, // wider ceiling for forced safety exits only (get out beats non-fill); covers the thinnest eligible tokens
  shadowFillToleranceBps: 40,
  kellyFraction: 0.25,
  calibrationMaxAgeDays: 7,

  allowInfiniteApprovals: false,
  approvalBufferBps: 50,
};

/** Verified competition constants. */
export const COMPETITION = {
  contractAddress: "0x212c61b9b72c95d95bf29cf032f5e5635629aed5",
  requiredChainId: 56,
  executionType: "spot_only" as const,
  allowedRouters: ["pancakeswap"] as const,
  tradingWindow: { startUtc: "2026-06-22T00:00:00Z", endUtc: "2026-06-28T23:59:59Z" },
  minTradesPerDay: 1,
  minTradesPerWeek: 7,
} as const;

/**
 * Load a RiskConfig from a partial env-derived map, applying defaults for any
 * missing key. Unknown keys are ignored. Numeric parsing is strict: a present
 * but non-numeric value throws rather than silently falling back (fail loud).
 */
export function loadRiskConfig(env: Record<string, string | undefined> = {}): RiskConfig {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid numeric env ${key}=${raw}`);
    }
    return parsed;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    return raw === "true" || raw === "1";
  };
  const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    if (!allowed.includes(raw as T)) {
      throw new Error(`Invalid env ${key}=${raw} (expected one of ${allowed.join(", ")})`);
    }
    return raw as T;
  };

  const d = DEFAULT_RISK_CONFIG;
  const loaded: RiskConfig = {
    startingCapitalUsd: num("STARTING_CAPITAL_USD", d.startingCapitalUsd),
    gasReserveUsd: num("GAS_RESERVE_USD", d.gasReserveUsd),
    maxConcurrentPositions: num("MAX_CONCURRENT_POSITIONS", d.maxConcurrentPositions),
    perTradeRiskPct: num("PER_TRADE_RISK_PCT", d.perTradeRiskPct),
    stopAtrMultiple: num("STOP_ATR_MULTIPLE", d.stopAtrMultiple),
    breakevenTriggerAtr: num("BREAKEVEN_TRIGGER_ATR", d.breakevenTriggerAtr),
    trailAtrMultiple: num("TRAIL_ATR_MULTIPLE", d.trailAtrMultiple),
    trailTightAtrMultiple: num("TRAIL_TIGHT_ATR_MULTIPLE", d.trailTightAtrMultiple),
    maxPositionPct: num("MAX_POSITION_PCT", d.maxPositionPct),
    attackNotionalMinUsd: num("ATTACK_NOTIONAL_MIN_USD", d.attackNotionalMinUsd),
    microScoutUsd: num("MICRO_SCOUT_USD", d.microScoutUsd),

    positionWatchIntervalSeconds: num("POSITION_WATCH_INTERVAL_SECONDS", d.positionWatchIntervalSeconds),
    watchStalenessLimitSeconds: num("WATCH_STALENESS_LIMIT_SECONDS", d.watchStalenessLimitSeconds),
    watchStalenessAction: oneOf("WATCH_STALENESS_ACTION", ["alert_only", "reduce"] as const, d.watchStalenessAction),

    trendingDeltaMin: num("TRENDING_DELTA_MIN", d.trendingDeltaMin),
    trendingTopN: num("TRENDING_TOP_N", d.trendingTopN),
    volumeExpansionMin: num("VOLUME_EXPANSION_MIN", d.volumeExpansionMin),
    spikeCooldownChecks: num("SPIKE_COOLDOWN_CHECKS", d.spikeCooldownChecks),
    maxRetracePct: num("MAX_RETRACE_PCT", d.maxRetracePct),
    spikeMinPct: num("SPIKE_MIN_PCT", d.spikeMinPct),
    rsOutperformMinBps: num("RS_OUTPERFORM_MIN_BPS", d.rsOutperformMinBps),

    minTradesPerDay: num("MIN_TRADES_PER_DAY", d.minTradesPerDay),
    targetTradesPerDay: num("TARGET_TRADES_PER_DAY", d.targetTradesPerDay),
    maxTradesPerDay: num("MAX_TRADES_PER_DAY", d.maxTradesPerDay),

    weeklyLegBudget: num("WEEKLY_LEG_BUDGET", d.weeklyLegBudget),
    flatBandLoPct: num("FLAT_BAND_LO_PCT", d.flatBandLoPct),
    flatBandHiPct: num("FLAT_BAND_HI_PCT", d.flatBandHiPct),
    defendTriggerPct: num("DEFEND_TRIGGER_PCT", d.defendTriggerPct),
    huntMinScore: num("HUNT_MIN_SCORE", d.huntMinScore),
    pressMinScore: num("PRESS_MIN_SCORE", d.pressMinScore),
    defendMinScore: num("DEFEND_MIN_SCORE", d.defendMinScore),
    netEdgeDefendBonusBps: num("NET_EDGE_DEFEND_BONUS_BPS", d.netEdgeDefendBonusBps),
    pressStartDay: num("PRESS_START_DAY", d.pressStartDay),

    redBenchmarkPct: num("RED_BENCHMARK_PCT", d.redBenchmarkPct),
    greenBenchmarkPct: num("GREEN_BENCHMARK_PCT", d.greenBenchmarkPct),
    redFearGreed: num("RED_FEAR_GREED", d.redFearGreed),
    greenFearGreed: num("GREEN_FEAR_GREED", d.greenFearGreed),
    redBreadth: num("RED_BREADTH", d.redBreadth),
    greenBreadth: num("GREEN_BREADTH", d.greenBreadth),
    regimeHysteresisChecks: num("REGIME_HYSTERESIS_CHECKS", d.regimeHysteresisChecks),
    regimeHighVolatilityRatio: num("REGIME_HIGH_VOLATILITY_RATIO", d.regimeHighVolatilityRatio),

    competitionDqDrawdownPct: num("COMPETITION_DQ_DRAWDOWN_PCT", d.competitionDqDrawdownPct),
    internalWindowDrawdownPct: num("INTERNAL_WINDOW_DRAWDOWN_PCT", d.internalWindowDrawdownPct),
    maxDailyDrawdownPct: num("MAX_DAILY_DRAWDOWN_PCT", d.maxDailyDrawdownPct),
    softDrawdownPct: num("SOFT_DRAWDOWN_PCT", d.softDrawdownPct),
    competitionFloorUsd: num("COMPETITION_FLOOR_USD", d.competitionFloorUsd),
    dangerPortfolioValueUsd: num("DANGER_PORTFOLIO_VALUE_USD", d.dangerPortfolioValueUsd),

    netEdgeMinBps: num("NET_EDGE_MIN_BPS", d.netEdgeMinBps),
    frictionBudgetBps: num("FRICTION_BUDGET_BPS", d.frictionBudgetBps),
    scoringSimCostBps: num("SCORING_SIM_COST_BPS", d.scoringSimCostBps),
    twakFeeBps: num("TWAK_FEE_BPS", d.twakFeeBps),
    walletFloorFraction: num("WALLET_FLOOR_FRACTION", d.walletFloorFraction),
    dustRoundTripCeilingBps: num("DUST_ROUND_TRIP_CEILING_BPS", d.dustRoundTripCeilingBps),
    maxSlippageBps: num("MAX_SLIPPAGE_BPS", d.maxSlippageBps),
    swapSlippageBufferBps: num("SWAP_SLIPPAGE_BUFFER_BPS", d.swapSlippageBufferBps),
    exitMaxSlippageBps: num("EXIT_MAX_SLIPPAGE_BPS", d.exitMaxSlippageBps),
    survivalLossStreak: num("SURVIVAL_LOSS_STREAK", d.survivalLossStreak),
    shadowFillToleranceBps: num("SHADOW_FILL_TOLERANCE_BPS", d.shadowFillToleranceBps),
    kellyFraction: num("KELLY_FRACTION", d.kellyFraction),
    calibrationMaxAgeDays: num("CALIBRATION_MAX_AGE_DAYS", d.calibrationMaxAgeDays),

    allowInfiniteApprovals: bool("ALLOW_INFINITE_APPROVALS", d.allowInfiniteApprovals),
    approvalBufferBps: num("APPROVAL_BUFFER_BPS", d.approvalBufferBps),
  };

  const requireRange = (key: keyof RiskConfig, min: number, max: number): void => {
    const value = loaded[key];
    if (typeof value !== "number" || value < min || value > max) {
      throw new Error(`Unsafe risk config ${String(key)}=${String(value)} (expected ${min}..${max})`);
    }
  };

  requireRange("startingCapitalUsd", 0.01, Number.MAX_SAFE_INTEGER);
  requireRange("gasReserveUsd", 0, loaded.startingCapitalUsd);
  requireRange("maxConcurrentPositions", 1, 10);
  requireRange("perTradeRiskPct", 0.01, 10);
  requireRange("maxPositionPct", 0.01, 100);
  requireRange("competitionDqDrawdownPct", 0.01, 100);
  requireRange("internalWindowDrawdownPct", 0.01, loaded.competitionDqDrawdownPct);
  requireRange("maxDailyDrawdownPct", 0.01, loaded.internalWindowDrawdownPct);
  requireRange("softDrawdownPct", 0.01, loaded.internalWindowDrawdownPct);
  requireRange("dangerPortfolioValueUsd", 0, loaded.startingCapitalUsd);
  requireRange("maxSlippageBps", 1, 500);
  requireRange("swapSlippageBufferBps", 0, loaded.maxSlippageBps);
  // Exit ceiling must be at least as wide as the entry cap (exits never tighter) and bounded.
  requireRange("exitMaxSlippageBps", loaded.maxSlippageBps, 500);
  // Breakeven trigger must be a sane positive ATR multiple (0 would arm the ratchet instantly).
  requireRange("breakevenTriggerAtr", 0.1, 10);
  requireRange("walletFloorFraction", 0, 2);
  requireRange("survivalLossStreak", 1, 20);

  if (loaded.softDrawdownPct > loaded.maxDailyDrawdownPct) {
    throw new Error(
      `Unsafe risk config softDrawdownPct=${loaded.softDrawdownPct} exceeds maxDailyDrawdownPct=${loaded.maxDailyDrawdownPct}`,
    );
  }
  if (loaded.minTradesPerDay > loaded.targetTradesPerDay || loaded.targetTradesPerDay > loaded.maxTradesPerDay) {
    throw new Error(
      `Unsafe trade-frequency config: require minTradesPerDay <= targetTradesPerDay <= maxTradesPerDay`,
    );
  }

  return loaded;
}
