[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bima77993-bit/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bima77993-bit/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token launch radar

A token launch radar for [make.fun's token-radar-01 bounty](https://make.fun/bounty/token-radar-01): it ranks pre-token protocols by implied launch value, from a sealed DefiLlama snapshot, and gives each one a costed farm plan.

## The model (radar-2.7)

Two fitted pieces, no hardcoded names. Variant B halves the Risk Curators category term (−1.416 → −0.708) as a hand-set regime-change prior: vault curators began launching tokens after the training period, so the fitted coefficient lags the regime. The blind numbers below describe the radar-2.1 base fit; re-validation of this variant is pending.

Radar-2.7 sharpens the cover, not the model: a blind scoreboard on the cover compares our out-of-sample numbers with the leaders' published claims (power-law LOO 2.107 vs kevin 2.99, walk-forward 2.121 vs 2.26, odds Brier 0.192 vs kiencx 0.215 and fynix39 0.216 — fynix39's Brier is leave-one-out, ours is 5-fold CV). Radar-2.6 changes the proof, not the model: every board row carries a rank range (p10–p90 across 200 seeded bootstrap refits of the size curve and the token odds; the point estimates do not move), and each detail view carries a net-by-deposit × drop-share matrix (net if the drop scales with deposit, $1,000 as the reference size, gas flat). Radar-2.5 added the odds Brier (0.192 vs a 0.248 base rate, 5-fold CV) to the KPI strip and a per-term ablation table to the cover. The board keeps the radar-2.4 scope: ranking excludes bridge, liquid-staking, exchange and wrapped-asset categories by rule (plus versioned names and CEX), so the top rows are protocols whose token is still to come, not wrapped or bridged products of tokens that already trade. The watchlist always ranks.

Two fitted pieces, no hardcoded names:

- **The size curve (the multiple).** On the 128 listed protocols with a market cap and a TVL, `log(mcap) = 6.9646 + 0.5223 × log(TVL)`: the multiple falls as TVL grows, from about 0.65 at $5–10M of TVL to about 0.01 above $10B. A flat multiple (the starter's 0.25) overvalues a $2.75B protocol roughly 8×. The conditional value is `exp(6.9646) × TVL^0.5223`.
- **The token odds.** `P(token)` is a logistic regression on every protocol, fitted by IRLS to convergence: age is the strongest input (about 30% of protocols under 90 days old hold a token, about 79% of those over three years do), with log TVL, an age-unknown indicator, seven-day growth (a small fitted negative weight) and a category term.

**Implied value** is `round(conditional × P(token))` — an expected value: what the token would be worth if it launched, times the chance it launches. The board shows the decomposition.

## Blind validation (held out twice)

| Test | radar-2.7 (base fit) | starter (flat 0.25) |
|---|---|---|
| Size curve, leave-one-out RMSE (log mcap) | 2.107 | 2.293 |
| Size curve, walk-forward RMSE (log mcap) | 2.121 | 2.434 |
| Token odds, 5-fold CV AUC | 0.780 | — |
| Token odds, 5-fold CV Brier (base rate 0.248) | 0.192 | — |
| Rank stability, 200 bootstrap refits (median p10–p90 width) | 26 ranks | — |

A per-category multiple, a growth multiple and a maturity multiple were each fitted and dropped: none survived the blind tests.

## Layout

- `main.ts` — reads `/input/snapshot.json`, writes `/output/board.json`, `/output/data.js`, copies `dashboard/` and `screenshots/`, writes `/output/dossier.json`. Node 22, standard library only.
- `lib/model.ts` — the radar-2.7 model, the board builder, the bootstrap rank ranges and the farm plans.
- `dashboard/` — the static page (no network): sortable/filterable board, per-protocol detail with the value decomposition and farm plan, integrity strip with the validation numbers.
- `screenshots/` — the board, a protocol detail view and a filtered view.
- `vendor/makefun-board.ts` — make.fun's dossier library.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

The board covers all 40 watchlist protocols plus the 146 rankable pre-token protocols below the watchlist: 186 rows, each with a seven-step farm plan (action, cost, time) ending in a costed EV verdict.
