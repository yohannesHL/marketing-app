# Funnels in the existing Launchpad workspace

The application shell is `components/workspace/AppShell.tsx`: the green sidebar
with Home, Campaigns, Content Studio, Social marketing and Integrations / channels.
Funnels lives inside this same shell, session and database. The public product
landing page remains at `/`; the signed-in home is `/dashboard`.

## Navigation and editing

- **Funnels** appears after Campaigns in the desktop sidebar and in the mobile
  **More** menu. It opens `/funnels` and highlights throughout the editor and
  journey history routes.
- The funnel area links to tracking sources and email campaigns. Search quick
  actions also open all three. TEST/LIVE selection is preserved between them.
- Funnel, tracking and email editors register with the workspace navigation guard.
  Sidebar, mobile, quick-action and sign-out controls respect pending writes,
  unsaved edits and one-time source credentials. The existing campaign and social
  editors keep their original save/discard dialogs.
- Sign-in accepts approved funnel deep links while rejecting external redirects
  and dropping unsupported query parameters.
- React Flow, stages, evidence rules, campaigns, automation controls, simulations,
  reports and journey history use the existing APIs. No embedded second app or
  alternate navigation shell is required.

```mermaid
flowchart TD
  Session[Launchpad customer session] --> Shell[Existing green sidebar workspace]
  Shell --> Dashboard[Home]
  Shell --> Campaigns[Campaign library and builder]
  Shell --> Studio[Content Studio and brand kit]
  Shell --> Social[Social posts and retained delivery details]
  Shell --> Funnels[Funnels list]
  Funnels --> Editor[React Flow editor and stage inspector]
  Editor --> Tracking[Tracking sources and event inbox]
  Editor --> Email[Email campaigns and sequences]
  Editor --> Results[Results and journey history]
  Campaigns --> DB[(Shared customer-owned database)]
  Social --> DB
  Editor --> DB
  Tracking --> DB
  Email --> DB
```

## Preserved work and review scope

- `codex/workspace-redesign` at `da30b00` preserves the screenshotted application,
  including its previously uncommitted campaign, Content Studio and AI work.
- `codex/funnel-editor-ui` at `173ca76` preserves the earlier funnel editor branch.
  Its separate navigation shell is not the shell used in this integration.
- `codex/workspace-funnels` combines both histories. Its PR targets `main`, where
  the funnel backend already exists, so the review shows the workspace application
  and editor integration without reintroducing the backend as new work.
- No existing development or production environment file or credential is changed.
  The additional environment documentation inherited from the workspace branch
  contains configuration examples, not customer credentials.

The workspace campaign planner and executable email sequences remain distinct
records with distinct purposes. The funnel's campaign actions operate on the
existing executable email campaign service; this integration does not silently
turn a social/blog/email planning draft into a sending sequence.

## Verification

Browser coverage includes sidebar entry, active navigation, mobile navigation at
320px, unsaved-edit cancellation/acceptance, environment continuity, sign-in deep
links, React Flow editing, tracking receipts, sequence controls and reports.
The existing customer-app suite covers campaign persistence, Content Studio,
social publishing and connection journeys.

The local visual verification uses the existing workspace database containing
the saved Clayroom campaign and its published Facebook/Instagram delivery rows.
Before adding the funnel schema, the database was backed up and all 47 existing
tables were compared before and after: every existing record was identical and
the foreign-key check passed. Local provider fixtures are still local fixtures;
this verification does not claim a production deployment or live delivery proof.

## Canvas connection controls

The journey canvas now uses orthogonal connectors with a plus button on every
path. An open stage or journey entry with no onward path gets a short line and
one plus beneath it. Connected stages have no duplicate card-level plus, and exit
stages have neither an onward handle nor a plus. Users can:

- Add a new stage with an explicit source/event connection.
- Connect an existing stage without dragging, or draw between the green handles.
- Insert a stage on one selected path. The original incoming condition and rule
  priority stay intact; the user chooses the later event for the onward path.
- Add a **Conditional stage** to an existing event rule with a required condition.
  Its existing destinations and fallback remain intact. The new condition is checked
  before the selected branch, or before an unconditional branch / fallback.
- Switch between **Canvas** and **List** to work with the same draft. The old
  numbered stage-navigation buttons are removed. The list names each milestone,
  its onward destinations and whether it ends the journey.
- Choose **Edit stage** to open and focus the right-side settings pane. Its
  **Close** button hides it and restores the canvas/list width. There is no separate
  settings button, dialog or drawer. The pane stays on the right from 768px upward;
  on small phones it remains inline below the journey, with Edit stage bringing
  its heading into view. Unfinished invalid fields survive and prevent closing
  or switching context.
- Save the draft or open publication review from the top right beside the title.
  Journey type, environment, status, saved revision and published version appear
  below the title. The previous command card and explanatory subheading are removed.
- Identify successful and unsuccessful exits by their compact endpoint cards,
  explicit Goal exit / Exit labels and green/red flag icons. Branch paths display
  their actual condition or Otherwise.

Layout remains local to the visit; both modes use the existing saved draft.

Connection setup uses a native modal dialog with keyboard focus containment,
Escape/cancel and return focus. Cancelling changes no draft data. Invalid source,
cycle, exit-stage and condition rules still apply. No action enables automation.
React Flow attribution is hidden through its supported `proOptions` setting;
the installed MIT license and copyright notice remain unchanged.

Validation for this update: TypeScript and production build passed; all 12
focused rule/inspector integration tests passed. Fifteen affected browser cases
were verified across Chromium, Firefox and WebKit. The final targeted run passed
all six navigation and canvas/list cases after correcting focus restoration; the
remaining nine connection, insertion and save/conflict cases passed in the prior
run. Coverage includes single-plus placement on drawn connectors, distinct exits,
Edit/Close behavior, right-side settings at 949px, inline settings on phones,
invalid input preservation, keyboard focus, persisted reloads and unchanged
provider activity.

The local workspace contains a separate unpublished TEST draft named
“Lead journey · builder review” and a “Local funnel review” TEST source for visual
verification. No events are sent, no provider is connected, and automation is off.
The existing Fluxsoft subscriptions draft and original campaigns are unchanged.
