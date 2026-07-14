# ZOL scripts (~/zol/farcaster-agent)

Model: anthropic/claude-fable-5 (OpenRouter). Shared helpers: zol-lib.js.

## Shared
- zol-lib.js - signer/submit/post/reply/remove/follow/resolveFid/ork/env. One-shot posters require this.

## One-shot (on demand)
- zol-post.js "<text>" [embedUrl]
- zol-post-tagged.js "<cast>" ["<reply>"] [user] [embedUrl]  (zabalgamez update poster: embeds link + tags @zaal)
- zol-reply-to.js <parentFid> <parentHash> "<text>" [embedUrl]
- zol-delete.js <hash...>
- zol-quote.js <fid> <hash> "<text>" - quote-cast a cast with ZOLs thoughts.
- post-reply.js <hash>  (publish a staged draft from ~/zol/drafts/)
- post-event.js <id>  (publish a staged event draft as an original cast - kind:"event" drafts from zol-calendar.js)

## Daemons (keep-alive via ~/start-fleet.sh)
- zol-reply.js   - drafts replies to @mentions (gated)
- zol-threads.js - watches replies to ZOL casts; Zaal feedback -> learn+ack, others -> draft+gate
- zol-daily.js   - daily curator draft (cron 16:00 UTC), auto-posts, 0-40min jitter before posting
- zol-learn-zaal.js - learns from Zaal Farcaster posts (-> zaal-learnings.md); quote-casts every 4th strong one with ZOL thoughts. AUTO (set ZOL_QUOTECAST_DRAFT=1 to gate). tmux zolz.
- zol-follow.js  - once/day, follows up to FOLLOW_DAILY_CAP (default 20) accounts @zaal already follows that ZOL doesn't yet. Free (Link message, same signer+api-key path as a cast) - no wallet, no spend. Telegram summary after each run, no pre-approval gate (mirrors zol-daily's auto-post precedent). Dry-run: ZOL_DRY=1.
- zol-calendar.js - polls the ZAO Luma ICS feed every 15 min, drafts a gated event cast for each event entering the "new" / "day-before" / "morning-of" moment (collapses to one cast if multiple moments are due at once). State: ~/zol/calendar-state.json. Nothing auto-posts - approve via post-event.js. Dry-run: ZOL_DRY=1.

## Other
- overnight.js, rotate.js, dashboard.js, test-post.js - see file headers.

Safety: no spend/launch/sign tool. @ stripped from generated text. Bot-blocklist enforced.
