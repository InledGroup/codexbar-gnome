# OpenCode and OpenCode Go Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method: native, approved by the user.

**Goal:** Make OpenCode and OpenCode Go selectable, authenticated, and usable in the local GNOME extension, then open a linked upstream issue and PR.

**Architecture:** Extend the existing provider preferences and usage-fetcher architecture. Use a shared direct Console adapter for Linux rather than depending on OpenCode's macOS-only CLI web path. Keep explicit CLI commands available; normalize Console data into the existing usage contract and preserve current providers and settings.

**Tech Stack:** GJS ES modules, GTK4/libadwaita, libsoup3, libsecret, gettext, existing CodexBar CLI 0.78.0, Bash cookie importer.

**Spec:** Design approved in this chat on 2026-10-20: two predefined providers, usage integration, logos, tests, documentation, local installation, upstream issue and PR. Linux Console adapter and workspace selection below are additions discovered during planning and are presented for review with this plan.

## Evidence and scope

- Base commit: `b337288` on `origin/main`. No product changes made during planning.
- `prefs.js:51` defines `PREDEFINED_PROVIDERS`; neither OpenCode ID is present. This is why neither has a predefined row to enable.
- Local GNOME extension `codexbar@inled.es`, version 23, is ACTIVE. Both `gjs` and `gnome-extensions` are installed.
- `codexbar --provider opencode --source auto --format json` exits 1: selected source requires web support available only on macOS.
- The equivalent `opencodego` invocation exits 1: no OpenCode Go session cookies found.
- Existing `test_all_providers.js` tests one Zen `providerCost` fixture, but not provider registration, authentication, or end-to-end fetch.
- Upstream reference at installed CLI tag: https://github.com/steipete/CodexBar/blob/v0.78.0/docs/opencode.md and the OpenCode/OpenCodeGo provider descriptors at that tag. Read the fetchers/parsers at that same tag before implementing request/response mapping.
- OpenCode here means its hosted Zen/Console account; Go means its separate subscription. Arbitrary third-party providers used inside OpenCode are outside this change.

## Global Constraints

- Keep IDs exactly `opencode` and `opencodego`, and names `OpenCode` and `OpenCode Go`.
- Remain compatible with declared GNOME Shell versions 48–51. No new runtime dependency.
- Wrap new user-facing text in `_()` and run `./update-po.sh`, per `CONTRIBUTING.md`.
- Store cookies through existing `secret.js`; never put credentials in GSettings, commands, logs, fixtures, issue bodies, or PR bodies.
- Preserve existing provider settings and hand-edited custom commands. New providers remain opt-in.
- Support current Console JSON endpoints. Legacy-only sessions receive an actionable sign-in message; do not port undocumented legacy server-function machinery in this PR.
- Preserve cancellation and timeout behavior. Do not turn malformed data or failed requests into zero usage.
- Do not log out the user or restart their GNOME session automatically.
- Original repository credit stays intact. Issue and PR must clearly disclose AI assistance; user explicitly authorized their creation.

## Review Focus

1. Multiple workspaces: never combine meters or balance across workspaces; require selection when ambiguous.
2. Missing Go subscription: distinguish successful absence of quota from expired authentication and PAYG usage.
3. Signed monetary values and zero limits: preserve negative/zero balances and never manufacture a quota percentage.
4. Existing custom providers: adopt only exact generated commands and preserve account flags, panel visibility, and deliberate duplicates.
5. Session failures and lifecycle: distinguish 401, 403, non-JSON responses, cancellation, and optional billing failure.

## Task 1: Linux Console data adapter

**Files:** Create `adapters/OpenCodeConsoleFetcher.js`; modify `usageApi.js`; extend `test_all_providers.js`.

**Interfaces:** `new OpenCodeConsoleFetcher(session)`; `fetch(cookieHeader, {providerId, workspaceId, cancellable}) -> Promise<normalizedSummary>`. `UsageApiClient.fetchSummary(cookies, providerId, cancellable, options = {})` dispatches these IDs to the adapter and leaves existing callers valid. Pure exported `normalizeOpenCodeConsole({providerId, goStatus, billingStatus, usageSummary, now})` returns the existing `{usage, labels}` contract.

- [ ] Read pinned upstream Console fetcher/parsers and record exact JSON envelopes in sanitized fixtures before writing mapping code.
- [ ] Add failing fixture tests: five-hour used/limit `25/100` yields 25%; weekly `50/100` yields 50%; monthly `75/100` yields 75%. Missing reset stays unknown; monthly may use subscription `endsAt`. Zero limit yields no percentage. Invalid monetary strings or missing required meter fields do not become 0%.
- [ ] Add failing money tests: `balanceMicroCents: "7363000000"` yields USD 73.63; `"0"` stays zero; `"-100000000"` stays -1. Never substitute `availableMicroCents`. A PAYG summary of `totalCostMicroCents: "1234000000"` maps to USD 12.34 spent over Last 30 days, without a quota denominator.
- [ ] Run `gjs -m test_all_providers.js`; confirm the new assertions fail for the intended missing implementation while noting the existing baseline results.
- [ ] Implement Console requests: `/console/api/orgs` discovery; `/console/api/go/status` and `/console/api/billing/status` with selected `x-org-id`. For base OpenCode without quota, confirm `/console/api/orgs/current` has `hasGoSubscription: false` and billing mode is `pay-as-you-go` before requesting `/console/api/usage/summary?range=30d`.
- [ ] Treat optional billing failure independently of successful Go meters. Only successful no-subscription responses yield an empty-subscription state; 401 requires sign-in, 403 remains a permission failure. Reject ambiguous workspace discovery without a selected workspace.
- [ ] Add local fake HTTP transport coverage for the exact headers and paths above, 401, 403, invalid JSON, ambiguous workspaces, no subscription, optional billing failure, and cancellation. Use synthetic cookies only; no remote calls in the test suite.
- [ ] Run the suite until it passes, then commit adapter, routing, and tests as `feat: fetch OpenCode Console usage on Linux`.

## Task 2: Provider setup, workspace selection, and presentation

**Files:** Modify `providerSources.js`, `prefs.js`, `extension.js`, `localize.js` if necessary, `test_all_providers.js`, `build.sh` only if adding a packaged module; add `media/logos/opencode-symbolic.svg` and `media/logos/opencodego-symbolic.svg`.

**Interfaces:** Export the predefined provider catalog from `providerSources.js` for preference rendering and tests. New entries have `useApi: true`, `supportsDirectApi: true`, and CLI defaults generated with their exact IDs and source `auto`. Optional persisted provider field `workspaceId: string` is passed to Task 1; absence is valid only for unambiguous discovery.

- [ ] Add failing tests verifying both catalog entries, distinct IDs, direct API default, CLI command round trips, and migration of exact generated custom commands. Test preserving `showInPanel` and leaving `--account work` or deliberate duplicates unchanged.
- [ ] Run the suite and confirm failures, then move the existing catalog without rewriting unrelated preference behavior; add the two provider entries.
- [ ] Add a workspace ID field for these direct providers and pass it through saved provider data and refresh calls. Keep existing configuration fields intact.
- [ ] Use the existing libsecret cookie field with OpenCode-specific guidance for `__Host-console_session`; show an actionable Console sign-in/setup explanation. Do not offer a browser import button that silently imports Codex cookies: enable it only if Task 3 supports that provider.
- [ ] Add symbolic logos consistent with the existing icon system and upstream attribution; cover name/ID resolution, including custom names, without matching OpenCode Go to an unrelated icon.
- [ ] Test and correct rendering only where required: all three Go meters and resets; base OpenCode PAYG spend and separate balance; zero/negative balances. Never label remaining balance as money spent or fabricate a progress bar for unlimited PAYG.
- [ ] Verify offline fixtures for balance-only and quota-plus-balance output; inspect actual preference rows and developer-mode fixtures in a nested GNOME session when available.
- [ ] Run `gjs -m test_all_providers.js`, then commit as `feat: expose OpenCode providers in preferences`.

## Task 3: Browser import and user documentation

**Files:** Modify `scripts/codexbar-cookie-importer`, `prefs.js`, `README.md`, gettext files under `po/`; add a focused helper test script if the existing JS suite cannot exercise the Bash helper.

**Interfaces:** Helper accepts `--provider opencode` and `--provider opencodego`, restricts reads to `opencode.ai`, and returns the existing `cookie_header` JSON contract. Preference invocation must forward the selected provider ID, not default to Codex.

- [ ] Add failing helper tests for both IDs, Console cookie selection, missing-cookie error, and domain boundaries excluding unrelated/lookalike domains. Use temporary fixture databases; never include real browser data in tests.
- [ ] Extend the existing domain/provider dispatch and preference helper invocation. Support the existing Chrome/Brave importer capabilities; do not introduce a new browser-decryption subsystem.
- [ ] Run helper tests and `bash -n scripts/codexbar-cookie-importer`; verify manual cookie entry remains usable if import is unavailable.
- [ ] Document where to enable the two rows, how to sign in/import or enter a session cookie, workspace selection, Linux CLI limitation, and minimum CLI support for optional CLI mode. Clearly distinguish OpenCode/Zen balance from Go subscription quota.
- [ ] Run `./update-po.sh`; inspect translation diff for unintended changes. Run `gjs -m test_all_providers.js` and `./build.sh`. Verify the archive includes both logos and the new adapter.
- [ ] Commit as `docs: document OpenCode Linux setup and cookie import` with helper changes included.

## Task 4: Local installation, end-to-end verification, issue and PR

**Files:** No new runtime files; update this checklist with actual validation results. Prepare issue/PR bodies as temporary files outside the product tree.

**Interfaces:** Working extension archive from Task 3; existing enabled UUID `codexbar@inled.es`; GitHub upstream `InledGroup/codexbar-gnome`; fork under authenticated `hlopez94` if upstream push access is unavailable.

- [ ] Read execution, worktree, verification, and review skills before implementing. Create a feature branch in the existing clean checkout; use isolation if execution instructions require it. Do not modify unrelated local work.
- [ ] Back up the currently installed extension and provider settings before local installation; preserve credentials without printing or copying them into this repository.
- [ ] Install the built archive and helper if changed. Avoid the destructive uninstall in `install.sh` where an in-place install suffices. Enable the extension and inspect status/logs.
- [ ] Reuse an authorized available OpenCode session through existing local secret/import mechanisms, then enable both rows while retaining all other providers. If no usable session exists, request user sign-in; never report fixture-only results as real account verification.
- [ ] On Wayland, use a nested shell for immediate fresh-code verification where available. If the main shell retains old code, explicitly report that logout/login is still required; an ACTIVE status alone does not prove it loaded the patch.
- [ ] Verify fresh Preferences contains both rows; actual fetch displays the selected workspace's real data, or a precise no-subscription state. Check an existing provider for regression. Record remaining environmental blockers separately.
- [ ] Run final suite, helper checks, schema compilation, packaging, `git diff --check`, and a focused review of auth, normalization, settings migration, and archive contents. Resolve findings before publication.
- [ ] Check upstream for duplicate issues/PRs, then create the requested issue describing missing selectors and verified Linux failures. Write a factual body disclosing AI assistance; link actual test evidence without credentials.
- [ ] Push branch to upstream or a fork, open a PR referencing `Fixes #<issue>`, describe final implementation and actual local verification, disclose AI assistance, and call `mcp__codex_app__attach_artifact` with the created PR URL.
- [ ] Return the issue and PR links, installed version/path, checks passed, and any remaining authentication or session-reload requirement. Do not claim completion while either real-data verification or required installation work remains pending.

## Plan self-review

- Provider discovery, Linux fetching, credentials, workspace scope, metrics, tests, translations, local deployment, issue and PR each have an owning task.
- All five Review Focus conditions have explicit fixture/transport/UI coverage above.
- Existing interfaces remain backward compatible; broader source-selector redesign, local cost estimates, and legacy server-function support are excluded.
- Implemented after explicit approval. Independent review found two custom-account row matching regressions; both were reproduced and fixed with tests before publication.


## Execution evidence (2026-10-20)

- `gjs -m test_all_providers.js`: passed, 44 check groups, including Console and preference migration regressions.
- `python3 test_cookie_importer.py`: passed, two offline tests covering plaintext domain/profile isolation and encrypted v11 Console sessions.
- `bash -n scripts/codexbar-cookie-importer`, `git diff --check`, schema compilation, gettext checks and `./build.sh`: passed.
- Fresh GTK4/libadwaita Preferences constructed both rows and workspace controls. Saving preserved an account-specific custom command and duplicate display names.
- Real existing Edge session imported; both provider IDs returned three quota windows and a separate Zen balance. Sessions stored in libsecret. Existing Codex CLI command still returned usage successfully.
- Built archive installed under `~/.local/share/gnome-shell/extensions/codexbar@inled.es`; updated importer installed under `~/.local/bin`. Existing extension/helper/settings backed up under `~/.local/state/codexbar-gnome-backups/2026-10-20-opencode`.
- Fresh headless GNOME Shell 50.6 loaded the installed extension with a three-window/balance developer fixture: ACTIVE, `GetExtensionErrors` returned an empty array. This checks fresh-code rendering, independently of the authenticated data-fetch check.
- Both provider configurations enabled while preserving the existing Codex entry. Main desktop activation still requires logout/login because GNOME caches extension JavaScript. The running desktop was not forcibly restarted.

### Execution decisions

- Used the fresh task checkout and a feature branch instead of another worktree; no unrelated work existed. Risk: no extra filesystem isolation, mitigated by the clean starting checkout.
- Added Edge paths and a `--profile` importer argument to support the user's existing browser and prevent combining Console sessions. Risk: other browser encryption/keyring formats still require manual cookie entry.
- Kept the Console v10/v11 decryption correction isolated from the older providers' decoder. Risk: this PR does not repair pre-existing decoder limitations for other providers.
- Required user logout/login for the primary shell rather than restarting their desktop. Limitation: installed code is verified in a fresh shell but not activated in the current main process.
