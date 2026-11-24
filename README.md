[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bima77993-bit/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bima77993-bit/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token launch radar

A token launch radar for [make.fun's token-radar-01 bounty](https://make.fun/bounty/token-radar-01): it ranks pre-token protocols by implied launch value, from a sealed DefiLlama snapshot, and gives each one a costed farm plan.

## The model (radar-2.1)

Two fitted pieces, no hardcoded names:

- **The size curve (the multiple).** On the 128 listed protocols with a market cap and a TVL, `log(mcap) = 6.9646 + 0.5223 × log(TVL)`: the multiple falls as TVL grows, from about 0.65 at $5–10M of TVL to about 0.01 above $10B. A flat multiple (the starter's 0.25) overvalues a $2.75B protocol roughly 8×. The conditional value is `exp(6.9646) × TVL^0.5223`.
- **The token odds.** `P(token)` is a logistic regression on every protocol, fitted by IRLS to convergence: age is the strongest input (about 30% of protocols under 90 days old hold a token, about 79% of those over three years do), with log TVL, an age-unknown indicator, seven-day growth (a small fitted negative weight) and a category term.

**Implied value** is `round(conditional × P(token))` — an expected value: what the token would be worth if it launched, times the chance it launches. The board shows the decomposition.

## Blind validation (held out twice)

| Test | radar-2.1 | starter (flat 0.25) |
|---|---|---|
| Size curve, leave-one-out RMSE (log mcap) | 2.107 | 2.293 |
| Size curve, walk-forward RMSE (log mcap) | 2.121 | 2.434 |
| Token odds, 5-fold CV AUC | 0.782 | — |

A per-category multiple, a growth multiple and a maturity multiple were each fitted and dropped: none survived the blind tests.

## Layout

- `main.ts` — reads `/input/snapshot.json`, writes `/output/board.json`, `/output/data.js`, copies `dashboard/` and `screenshots/`, writes `/output/dossier.json`. Node 22, standard library only.
- `lib/model.ts` — the radar-2.1 model, the board builder and the farm plans.
- `dashboard/` — the static page (no network): sortable/filterable board, per-protocol detail with the value decomposition and farm plan, integrity strip with the validation numbers.
- `screenshots/` — the board, a protocol detail view and a filtered view.
- `vendor/makefun-board.ts` — make.fun's dossier library.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

The board covers all 40 watchlist protocols plus the 160 rankable pre-token protocols with the highest expected implied value: 200 rows, each with a seven-step farm plan (action, cost, time) ending in a costed EV verdict.
