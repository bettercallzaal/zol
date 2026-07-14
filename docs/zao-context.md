# ZAO ecosystem context for ZOL

Grounded facts ZOL can safely reference, pulled from the ICM boxes
(useicm.com - AI-readable context boxes, unauthenticated read) plus the ZAO
research library. Where a number is uncertain, it says so - do not upgrade an
uncertain figure to a stated fact when drafting a cast.

## The ZAO (source: ICM box `thezao`, live)

ZAO = ZTalent Artist Organization. A decentralized impact network, not a record
label or "music community" - first artist domain is music, returns artists
profit margin, data, and IP rights. Founded by Zaal Panthaki (BetterCallZaal).
Priority stack: music first, community second, technology third.

Governance: Respect (soulbound OG ERC-20 + ZOR ERC-1155, both on Optimism) is
the on-chain contribution currency. Weekly Respect Game, Fibonacci-curve
rewards, ~100+ unbroken weeks since 2024-07-30. On-chain execution via OREC
(72h vote + 72h veto). As of 2026-07-05: 156 unique Respect holders (122 OG +
55 ZOR, 21 hold both).

Production lanes: WaveWarZ, ZABAL Games, the ZAO festivals (ZAOstock, ZAOville,
ZAO-PALOOZA, ZAO-CHELLA), ZAO OS (the lab/monorepo).

## ZABAL Games (source: ICM box `zabalgamez`, live)

The ZAO's 3-month build-a-thon, free, Farcaster-native. Three tracks: Artist,
Builder, Creator. 2026 arc: June recorded workshops, July open build month
(goal: 200 distinct builders, set 2026-07-04), August Finals (mentor pairs,
24h build, Respect-weighted vote, USDC prizes). Entry via zabalgamez.com
(signups/collectibles through app.magnetiq.xyz). Bonfire is the system of
record for submissions.

## WaveWarZ (source: ICM box `wavewarz`, not yet minted, + research doc 974)

Live-traded music battles: artists battle, fans trade positions and earn.
Prediction-market style, Solana mainnet + Base testnet, bridged via Mayan/
Wormhole. Quick battles weekdays, main events Sundays.

**Financials are directional, not settled** (doc 974, last validated
2026-07-06): all-time volume ~491 SOL (~$33K) per WaveWarZ Intelligence vs. a
"$60k+" testimonial elsewhere - these disagree and haven't been reconciled.
Cumulative artist payouts ~8.7-8.9 SOL; platform revenue ~15.9 SOL - i.e. the
platform has taken roughly 1.8x what artists have earned so far, mostly via
launch/queue fees. **Never cite a specific WaveWarZ number in a ZOL cast
without checking it live against wavewarz-intelligence.vercel.app first** -
this is the same rule that already exists after the 2026-07-01 LUI burn
(fabricated "29.59 SOL volume" vs. real ~0.05-0.1 SOL/battle).

## Zaal / BetterCallZaal (source: ICM box `zaal`, not yet minted)

Founder of The ZAO. Electrical engineer (BS EE, RIT 2022), Maine-based, builds
in public. Also runs BetterCallZaal Strategies LLC, COC Concertz. Ships
MVP-first, mobile-first, dark theme, Farcaster-native, uses Claude Code
heavily. Farcaster: @zaal (FID 19640, also posts as @bettercallzaal).

## ZAO Assistant / the bot fleet (source: ICM box `zao-assistant`, live)

Confirms where ZOL sits in the fleet: "Farcaster build-in-public via ZOL (the
ZAO music-scout agent)." Fleet-wide rules that apply to ZOL too: pull-request
only (never push main), outbound posts/DMs/spend/on-chain actions stay
human-gated, facts only (no invented numbers/dates/partners), no emojis, no em
dashes.

## Bonfire - what it actually gives ZOL right now

Bonfire (`zabal.bonfires.ai`, API base `tnt-v2.api.bonfires.ai`) is currently
**write-mostly**: episodes POST cleanly to `/knowledge_graph/episode/create`
and grow the graph, but the read endpoint (`/vector_store/search`) returns `[]`
until an admin runs labeling on the non-admin key (`/labeling/hybrid` is 403).
So any script or doc that assumes ZOL "draws context from Bonfire" today is
describing the intended end state, not what's live - ZOE's own `recall()` code
already falls back gracefully for the same reason. Until labeling is turned on,
ZOL's actual grounded-context source is the ICM boxes above (readable,
unauthenticated) plus whatever gets hand-carried into the persona/prompts.

## A stale planning thread worth knowing about

Research docs 891 (2026-06-23) and 993 (2026-07-12) lay out a more ambitious
ZOL architecture - Privy-signed wallet, Snaps/Frames with in-cast buttons, a
$ZABAL tip/mint economic loop, cross-posting to X, webhook mentions - built
against a different (TypeScript, `bot/src/zoe/caster/`) codebase than what is
actually running on the Pi (plain JS, free api-key posting, no Privy, no Snap,
no mint infra). Treat both docs as an idea backlog, not a description of ZOL's
current build. The economic-loop recommendation in particular (doc 993's #2
priority) is exactly the spend/sign-tx capability ZOL is designed not to have -
don't inherit it into this repo without a fresh decision from Zaal, separate
from anything already settled about `overnight.js`.

## Sources
- ICM boxes: `useicm.com` - thezao, zabalgamez, zao-assistant (live); wavewarz,
  zaal (content drafted, not yet minted) - `research/identity/icm-boxes/`.
- ZAO research library: docs 974 (WaveWarZ financials), 891 + 993 (ZOL upgrade
  planning), 665/717/680/754 (Bonfire architecture + the read-path gate).
