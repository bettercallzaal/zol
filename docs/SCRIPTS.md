# ZOL scripts (~/zol/farcaster-agent)

Model: anthropic/claude-fable-5 (OpenRouter). Shared helpers: zol-lib.js.

## Shared
- zol-lib.js - signer/submit/post/reply/remove/resolveFid/ork/env. One-shot posters require this.

## One-shot (on demand)
- zol-post.js "<text>" [embedUrl]
- zol-post-tagged.js "<cast>" ["<reply>"] [user] [embedUrl]  (zabalgamez update poster: embeds link + tags @zaal)
- zol-reply-to.js <parentFid> <parentHash> "<text>" [embedUrl]
- zol-delete.js <hash...>
- zol-quote.js <fid> <hash> "<text>" - quote-cast a cast with ZOLs thoughts.
- post-reply.js <hash>  (publish a staged draft from ~/zol/drafts/)

## Daemons (keep-alive via ~/start-fleet.sh)
- zol-reply.js   - drafts replies to @mentions (gated)
- zol-threads.js - watches replies to ZOL casts; Zaal feedback -> learn+ack, others -> draft+gate
- zol-daily.js   - daily curator draft (cron 16:00 UTC)
- zol-learn-zaal.js - learns from Zaal Farcaster posts (-> zaal-learnings.md); quote-casts every 4th strong one with ZOL thoughts. AUTO (set ZOL_QUOTECAST_DRAFT=1 to gate). tmux zolz.

## Other
- overnight.js, rotate.js, dashboard.js, test-post.js - see file headers.

Safety: no spend/launch/sign tool. @ stripped from generated text. Bot-blocklist enforced.
