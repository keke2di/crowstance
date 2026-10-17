# Real-World Actions: First Service Design

Status: design only. The rails are built (vault, action audit, task-scoped consent); no live service integration exists yet. This document decides what the first one is and how it must work before we build it.

## Mode: prepare-and-confirm

The agent does everything up to the irreversible step — builds the basket, fills the forms, picks the slot — and stops there. The user gets one message with a summary and a confirm button. Payment/ordering is never silent, never "assumed". The consent reference (approval request id) is recorded in `action_audit` and the action only becomes `completed` with `consent: explicit`.

## Candidate services (evaluate, pick one)

| Candidate | Why | Risks |
|---|---|---|
| Food delivery (e.g. Glovo/Wolt/Deliveroo) | Low stakes, frequent use, clear "confirm" moment | ToS often bans automation; card declines on datacenter IPs; no official ordering APIs for consumers |
| Calendar/booking (e.g. barber, doctor via booking platforms) | Often has public booking flows, no payment | Account creation, captcha |
| Shopping with virtual card (e.g. a small retailer with an API) | Full control, official API | Few interesting ones exist |

**Recommendation:** start with whichever single food-delivery service the user actually uses weekly, because low stakes + high repetition is where prepare-and-confirm pays off. Prefer its official API if it has one (some expose ordering to partners); fall back to browser automation only as a last resort, in a dedicated sandbox profile with its own network identity.

## Hard requirements for any first integration

1. **Payment** via a virtual/single-use card (e.g. Revolut disposable or similar) with per-order and monthly caps enforced *at the card issuer*, not just in software. The user's real card is never on the box.
2. **Vault handles**: credentials are stored by the operator (`scripts/vault-add.ts` or a manual flow), referenced by handle (`glovo_login`, `virtual_card`), and used through `Vault.use()` only inside a gateway-side action runner. The agent can list handles but can never read values.
3. **Audit**: every step is recorded with `hq_action_record` before it happens: `prepared basket` (consent: none) → user confirms → `placed order` (consent: explicit, consent_ref = approval id) → `completed`/`failed`.
4. **One tap confirm**: the confirmation arrives as an approval prompt with the full summary (items, price, address, slot). Deny or ignore = nothing happens, basket abandoned.
5. **Caps**: `ACTION_MAX_ORDER_USD` (default 40) and `ACTION_MONTHLY_USD` (default 200), enforced in the action runner before any external call. Cost estimates are recorded even for prepared-only actions.
6. **Prompt-injection posture**: the action runner, not the model, constructs the final order payload. The model proposes; the runner validates against an allowlist (restaurant, items, address). Anything the model read from the web is untrusted input.

## What we build when this moves to implementation

- `src/actions/runner.ts`: takes a structured proposal (validated with zod), fills the basket via the service's API/browser driver, calls `Vault.use()` for credentials, records audit rows, and stops at the confirm step.
- An approval kind `action` in the approvals pipeline with a dedicated rendering (basket summary + price + Confirm/Deny).
- `hq_action_propose` MCP tool for the assistant to hand a proposal to the runner.
- `docs/OPERATIONS.md` section: adding credentials, rotating them, reading `/actions`.

## Explicitly not yet

- No subscriptions or standing orders ("buy milk every week") until single orders are boring.
- No browser automation until the API path is ruled out in writing.
- No "remember my usual order and just do it" — every order gets a confirm tap.
