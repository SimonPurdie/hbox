# Engineering priorities

This document records the follow-up work from the static review of `main`.
The review is broadly correct. HBOX does not need a new architecture, but its
coordination rules must become stronger before the number of Entries and
Sessions grows.

The priorities below are in implementation order. Tests listed under a
priority are part of that work, not a separate final test phase.

## 1. Prevent overlapping Session reconciliation

**Status: complete.**

**Assessment: agree. This is the highest-priority issue.**

`SessionManager` starts a reconciliation operation every two seconds. Each
operation joins the same global queue as user actions. Reconciliation checks
Sessions one at a time, and a runtime inspection or readiness probe can take
longer than the timer interval. Timer operations can therefore accumulate and
delay start, stop, restart, open, recheck, forget, and list requests.

Address this in two stages:

1. Replace the interval with a self-scheduling timer. Schedule the next
   automatic check only after the current check completes. Coalesce a manual
   request with a check that is already pending or running.
2. Remove unrelated Sessions from one global critical section. Use bounded
   concurrency for inspection and readiness I/O, and serialize operations for
   each Session. Before an inspection result changes state, confirm that it
   still applies to the same Session revision. Keep persistence serialized.

The revision check is important. Moving external I/O outside the current lock
without it could let an old inspection overwrite a newer stop or restart
result.

Add deterministic tests that prove:

- Slow probes do not create a queue of reconciliation cycles.
- A slow Session does not delay an action on another Session.
- A stale inspection cannot overwrite a newer user operation.
- Session state remains valid when several inspections complete together.

## 2. Make Registry changes transactional

**Status: complete.**

**Assessment: agree. Atomic file replacement does not prevent lost updates.**

Entry operations currently load, change, and save independent snapshots.
Overlapping requests can both load the same version and then save in a
different order. A metadata refresh can therefore undo a pin, registration,
reorder, or removal.

Make `Registry` the owner of the authoritative in-process state:

- Load and validate the file once during initialization.
- Return snapshots for reads.
- Provide one serialized update operation for all mutations.
- Save each accepted update with the current atomic replacement method.
- Merge refresh results into the current Entry by ID. Do not save the older
  snapshot used to perform filesystem I/O.
- Recheck uniqueness and existence inside the update operation when a result
  depends on them.

Do not hold the Registry update lock while reading project folders or
normalizing icons. Those results can be prepared first and merged
conditionally.

Add tests with controlled overlapping operations. They must prove that a
refresh cannot undo a pin and that registration, reorder, and removal do not
lose one another's changes.

`PreferencesStore` has only one editable field, so it does not need this
change now. Use the same pattern if it gains independent fields or overlapping
writers.

## 3. Bound Entry refresh work

**Assessment: agree with the immediate controls; defer speculative caching.**

`listEntries()` refreshes every Entry with an unrestricted `Promise.all`.
This is acceptable for the present data set, but it has no upper bound when
folders are slow, unavailable, on a sleeping disk, or accessed through WSL.

After Registry transactions are safe:

- Add a small concurrency limit to Entry refresh.
- Read independent metadata and icon information concurrently where this
  keeps the parser simple.
- Do not remove a nonexistent icon cache on every refresh. Clean it when an
  Entry changes from a custom icon or during a relevant cache update.
- Add controlled latency tests that assert the concurrency bound and
  completion behavior. Avoid fragile wall-clock performance thresholds.

Do not add an asynchronous stale-while-refresh model yet. HBOX already uses
last-known metadata when a folder is unavailable, and returning stale data
while an available folder refreshes would add consistency and UI timing
rules. Add a metadata cache only if measurement shows that bounded refresh is
still too slow.

Keep the current modification-time and size icon cache key unless stale icons
are observed. A content hash would require reading the complete source file
and would reduce the value of the cache.

## 4. Return metadata diagnostics from the canonical parser

**Assessment: agree.**

The runtime parser permissively omits invalid declarations. The integration
inspector then reads and parses `entry.json` again to infer what was omitted.
This creates two interpretations of the same integration contract and gives
imprecise errors.

Change metadata parsing to return both the effective value and structured
diagnostics. A diagnostic should identify the field path and the reason for
rejection. `readEntryMetadata`, runtime actions, and the integration inspector
must use the same result.

Keep permissive runtime behavior: one invalid declaration must not make all
valid metadata unusable. The inspector can report the rejected declaration
precisely.

Add tests for invalid commands, invalid optional URLs, unknown Session
references, reserved action IDs, and rejected default actions. Update
`src/server/hbox-contract.md` if this work changes any public integration
rule or inspector output contract.

## 5. Share wire types and small validation primitives

**Assessment: agree, with a narrow scope.**

The client and server duplicate tag priority, Entry DTOs, Session DTOs, action
types, and metadata status. Registry and Session persistence also duplicate
basic checks for locations, UUIDs, commands, and records. The Windows path
rules have already drifted: Registry accepts any non-empty path while the
Session store requires an absolute Windows path.

Create a browser-safe shared module for:

- HTTP request and response DTOs.
- Shared discriminated unions.
- Tag and action constants.

Keep client behavior such as filtering and theme calculation in the client.
Keep server domain and persistence types on the server. Shared compile-time
types do not require a runtime validation library.

Create small canonical validation functions for true cross-store invariants,
such as Entry locations, UUIDs, and command arrays. Do not combine unrelated
versioned persistence schemas into one large validator.

The build and type-check must consume the same shared source from both
targets. This provides the test that the client and server contract cannot
silently drift. Runtime validation is still required at file and HTTP
boundaries.

## 6. Split large modules along feature boundaries

**Assessment: agree, but do this as incremental behavior-preserving work.**

The direct DOM client and native runtimes remain suitable choices. Some files
are now large enough to make focused changes and tests difficult.

Split the client by visible feature:

- Entry desktop and pin interaction.
- Entry details.
- Sessions pane.
- Preferences.
- HTTP client.

Keep shared page state and event ownership explicit. This refactor must not
add UI elements or change interaction design.

Split the Windows runner by stable native responsibility, such as
configuration and persisted identity, process and Job Object ownership,
command resolution, and named-pipe control. Compile the source files into the
same single helper executable.

Move the embedded WSL runner scripts into versioned `.sh` source files that
the build copies into the distribution. This permits direct syntax checks and
ShellCheck without changing deployment behavior.

Do these as separate changes with existing lifecycle tests kept green. Add
focused tests only where extraction exposes a useful seam.

## 7. Improve the development loop without weakening start behavior

**Assessment: partly agree.**

A watch command would reduce iteration time, but it is not a runtime issue.
Add it after the coordination work. It must handle TypeScript, static assets,
native helpers, and Windows server restart clearly.

Make normal `start` and in-app Restart verify that the existing build is
current. Rebuild only when it is not. Use a build fingerprint rather than Git
working-tree status: a clean checkout can contain a build from an older
commit, while an unrelated documentation change can make the working tree
dirty.

The fingerprint must cover all build inputs, including source files, static
assets, build scripts, TypeScript configuration, the dependency lock file,
the target platform, and relevant tool versions. Treat missing expected
outputs or a build made for another platform as stale. Write the fingerprint
only after the staged build and swap completes successfully.

Keep an explicit `build` command that always performs a complete build.
`start` and in-app Restart should use the freshness check, so both retain the
guarantee that they serve current client assets and native helpers without
repeating unchanged work. Add tests for changed inputs, missing outputs,
platform changes, and failed builds that must not update the fingerprint.

Test the final start command with Windows Node, as required by `AGENTS.md`.

Keep the current Framework64 C# compiler while it is available on the target
machine. It supports HBOX without adding a .NET SDK prerequisite. Improve
compiler discovery and its failure message if this path becomes unreliable.
Do not introduce an SDK-style project only for better tooling.

## Decisions to preserve

Keep these foundations unchanged:

- JSON persistence with atomic replacement.
- Node's built-in HTTP server.
- Command argument arrays instead of shell command strings.
- Session definition snapshots.
- Last-known Entry metadata for unavailable folders.
- Verification through the real metadata parser and SVG normalizer.
- Windows Job Objects and the current Windows supervisor model.
- WSL boot, process, process-group, start-time, and token identity checks.

These choices fit HBOX's local, lightweight purpose. The next work should make
their coordination rules stronger, not replace them.
