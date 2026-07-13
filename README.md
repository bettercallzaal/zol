# ZOL

ZOL is [@zolbot](https://farcaster.xyz/zolbot) (FID 3338501) - the ZAO scene's
music curator on Farcaster. Tasteful, tireless, low-ego. ZOL finds and frames
music worth hearing from The ZAO, COC Concertz, and WaveWarZ artists, and helps
musicians land on Farcaster. It is a child of ZOE (the ZAO's cowork bot) and
inherits ZOE's voice constitution - see `persona.md`.

ZOL holds a Base wallet (`0x5A3F9a4f20e602eeaa03019F863fcA249f452D22`, USDC) for
identity purposes. **ZOL has no spend, launch, or sign-transaction capability by
design.** The one script that used to touch a wallet (`overnight.js`'s
auto-follow loop) has had that logic removed - see "What changed in this repo"
below.

## Where this runs

ZOL runs on a Raspberry Pi (`zaal@ansuz`, reachable over Tailscale), cron- and
tmux-driven. This repo is the source of truth; the Pi clones it and pulls to
update. See "Pi deploy flow" below.

## Architecture

- **Posting/signing**: `@farcaster/hub-nodejs` builds a `CastAdd`, signs it
  locally with ZOL's registered Ed25519 signer (key lives only in
  `~/.openclaw/farcaster-credentials.json` on the Pi, never in this repo), and
  submits the bytes to the Neynar hub (`hub-api.neynar.com/v1/submitMessage`)
  authenticated with an API key header. This is free - no on-chain payment, no
  x402. Do not reintroduce x402 for posting; that path was tried and dropped
  (see `legacy-setup/`).
- **Reads**: `haatz.quilibrium.com` (a free Farcaster hub mirror, no auth) for
  most discovery/context reads; Neynar's REST API where haatz doesn't cover it
  (e.g. username lookup).
- **Drafting**: OpenRouter, model `anthropic/claude-fable-5`, via `zol-lib.js`'s
  `ork()` helper.
- **Context**: the ZABAL Bonfire knowledge graph for broader ZAO ecosystem
  grounding.
- **Persona**: `persona.md` in this repo is the seed. The live persona that
  actually runs is `~/zol/zol-persona.md` on the Pi - keep them in sync by hand
  until the Pi is migrated to read straight from this repo (see below).

## Repo layout

```
src/            zol-lib.js (shared signer/submit/post/reply/remove/ork helpers)
                add-signer.js, config.js (used only by scripts/rotate.js)
scripts/        every cron entrypoint and one-shot CLI tool - see docs/SCRIPTS.md
docs/           AGENT_GUIDE.md, SCRIPTS.md, neynar-learnings.md, SKILL.md
legacy-setup/   archived one-time FID/signer bootstrap template - dead code,
                kept for reference only, see legacy-setup/README.md
persona.md      persona seed (live copy runs from the Pi's home dir)
.env.example    every env var NAME the code touches - no values, ever
```

## Cron schedule (on the Pi)

```
0 0-2,9-23 * * *  zol-daily.js        - daily curator cast, auto-posts (see below)
*/5 * * * *       zol-zabal-watch.js  - ZABAL_WATCHER_LIVE=1
*/10 * * * *      zol-win-drain.js
*/5 * * * *       zol-drain.js        - ZOL_DRAIN_LIVE=1
@reboot + */15    start-fleet.sh      - self-healing supervisor, see below
```

`start-fleet.sh` keeps three daemons alive via tmux, restarting them if the
underlying process (not just the tmux session) has died:

```
tmux zol   -> node scripts/zol-reply.js       (drafts replies to @mentions, gated)
tmux zolt  -> node scripts/zol-threads.js     (watches replies to ZOL's own casts)
tmux zolz  -> node scripts/zol-learn-zaal.js  (learns from Zaal's Farcaster posts)
```

## The gated-posting model

Nothing posts to Farcaster without a human okaying it first, with one
exception noted below:

- `zol-reply.js` and `zol-threads.js` draft replies to disk under `~/zol/drafts/`
  and ping Zaal on Telegram. Zaal reviews via `dashboard.js` (served on the Pi's
  Tailscale IP, port 8088) or runs `node scripts/post-reply.js <hash>` directly.
  Nothing posts until one of those runs.
- `zol-daily.js` is the one exception: it auto-posts on-brand curator casts (the
  "quiet drafts" part of the model still applies to replies and threads, not to
  this daily cast). That's intentional and should stay that way.
- Operator feedback from Zaal (corrections to ZOL's behavior/persona) is
  absorbed silently into the persona and confirmed privately on Telegram - ZOL
  does not post a public acknowledgment of feedback. Do not revert this.

## What changed in this repo (vs. what may still be running on the Pi)

- `overnight.js`: the custody-wallet / x402 / auto-follow logic has been
  removed. It is now read-only research (haatz discovery + theme extraction +
  OpenRouter-drafted cast ideas written to a report). If the Pi's copy still has
  the old wallet-spend version, the Pi's copy is stale - pull this repo's
  version and it goes away.
- `dashboard.js`: dropped the dead "Follows" counter (no longer meaningful once
  overnight.js stopped following anyone) and a stale "~$0.01" cost label left
  over from an earlier x402-based posting flow that's no longer in use.
- Everything else is a straight lift of the Pi's live files into this
  structure, with only `require()` paths adjusted for the new folder layout.

## Secrets

Secrets never live in this repo. See `.env.example` for every var name the code
touches and where its real value actually lives on the Pi (mostly fixed files
under `~/.zao/private/` and `~/.openclaw/`, a few passed inline by cron/tmux).
Run `scripts/secret-scan.sh` before every commit (`--all` to scan the whole
tree, default scans staged files only) - it refuses to let a 64-hex string, a
`sk-`/`gho_`/`ghp_`-shaped key, or a PEM private key block get committed.

## Pi deploy flow

The Pi clones this repo to `~/zol/farcaster-agent` and pulls to update:

```
ssh zaal@ansuz
cd ~/zol/farcaster-agent
git pull
npm install --omit=dev   # only if package.json changed
```

Cron entries invoke scripts by path (e.g. `node scripts/zol-daily.js`), so they
pick up a new pull automatically on their next run - nothing to restart for
those. The three tmux daemons (`zol`, `zolt`, `zolz`) need a manual restart
after a pull that touches their scripts:

```
tmux kill-session -t zolt   # or zol / zolz
```

`start-fleet.sh`'s self-healing check (runs every 15 min via cron, and at
`@reboot`) will notice the process is gone and restart it automatically within
15 minutes; kill it manually first if you want the new code running sooner.

Before editing anything live on the Pi: back up the file you're about to
change, and run `node --check <file>` after editing, before it goes anywhere
near cron or tmux.
