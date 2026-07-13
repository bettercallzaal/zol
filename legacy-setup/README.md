# legacy-setup

Archived. This is the original third-party FID/account-creation template ZOL's Pi
was bootstrapped from (`register-fid.js`, `add-signer.js`, `post-cast.js`,
`set-profile.js`, `swap-to-usdc.js`, `x402.js`, `credentials.js`, `index.js`,
`agent-service/`). It registered ZOL's FID, added its first signer, and set its
profile - all one-time, already done. `agent-service/` is an abandoned Vercel +
x402 webhook stub; do not revive it (see the ZOL skill hard rule: no x402 payment
for posting - that path was replaced by the free api-key hub submit ZOL uses now).

None of this runs in production and none of it is on any cron. It is kept only
in case the signer ever needs to be re-registered from scratch (as opposed to
rotated - for that, use `scripts/rotate.js`, which is live and depends on
`src/add-signer.js` + `src/config.js`, not on anything else in this folder).

Has its own `package.json` (pins `ethers`, which the live agent otherwise
doesn't need) so it doesn't pull an extra dependency into the main install.
