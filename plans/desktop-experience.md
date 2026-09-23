# Desktop experience specification

**Status: design proposal.** This document describes the intended product experience; it does not claim that any screen or behavior has been implemented. It develops the two supplied sketches and Assignment A into a macOS-first operator application, followed by Windows. The desktop client connects to real browser sessions running in isolated cloud workers. Reconnecting attaches to the same session while its worker and browser survive; browser loss requires explicit recovery and a new session generation.

The product helps people discover an operation, turn it into a reviewed reusable capability, run it with new inputs, and intervene when necessary. Its interface should continuously answer four questions: which institution and application is involved, who has control, what has been verified, and what needs attention.

## 1. Welcome and workspace access

Follow the welcome sketch with a two-column composition: a corporate workplace photograph featuring men and women on the left; the product name, a short purpose statement, and sign-in on the right. Use a properly licensed or commissioned asset when implementing the screen. Keep the photograph decorative and give the sign-in controls the strongest visual hierarchy.

Provide “Continue with Google” and an enterprise SSO entry point. After authentication, show the institutions the person can access and their role in each. Application credentials are separate from product identity: signing into this console does not imply permission to enter every connected business application.

First-time setup identifies the institution, connects its target application instance, and checks worker readiness. Explain each requested permission when it becomes relevant. Request microphone access when the person first chooses voice input.

## 2. Navigation and application identity

The left navigation contains Overview, Runs, Capabilities, Interventions, and Applications. Place Account and Settings at the bottom, as in the sketch. Show the institution switcher at the top. Policy administration appears only for authorized roles.

Every run retains its original institution, environment, application instance, initiating user, and capability version. Switching institutions changes the surrounding workspace without retargeting an active run. Returning to that run restores its identity prominently.

Overview is the normal landing screen. Lead with work needing attention, followed by active runs and recent outcomes. An open-ended goal composer invites “What do you need done?” Application selection provides context without forcing a predefined task category.

## 3. Run Workspace hierarchy

Preserve the sketch’s three-column arrangement:

```text
Institution / navigation | Goal, application, run mode, current status
                        | Session toolbar             | Current step
                        | Live application session    | Verified timeline
                        |                             | Intervention details
Account / Settings      | Instructions and voice      | Results / evidence
```

Use a collapsible navigation rail, a flexible central session, and a resizable right inspector. Start around 220 pixels for navigation and 330 pixels for the inspector, then validate against real application screens. Provide a session focus mode that collapses both sidebars without removing essential controls.

The run header displays the goal, institution, environment, application, run identifier, and mode: Discovery, Deterministic replay, or Human control. The session toolbar shows the control owner, connection state, last received frame, and Pause, Stop, and Take control actions.

The center displays the actual worker session. Indicate scaling clearly and preserve the mapping between the displayed viewport and input coordinates. Operators can zoom or fit the view; target input is enabled only for the current controller.

The right inspector starts with the current step and its verified prerequisites. Its timeline distinguishes Planned, In progress, Verified, Waiting, Skipped, and Failed. A click is recorded as an action; a successful state check marks the step verified. Expand a step to inspect its expected state, observed result, and redacted evidence.

Keep the instruction composer beneath the session. Show concise updates and operator messages there; the timeline remains the authoritative account of execution.

## 4. Open-ended goals and reusable capabilities

The user enters a goal, chooses an application instance, and supplies any required inputs. When a compatible approved capability exists, show its name, version, intended operation, typed inputs, and declared outputs. Clearly identify that execution will use deterministic replay.

For an unsupported goal, offer discovery within the application’s configured permissions. Preview the intended scope and stopping conditions. Ask for missing information when it affects the task; do not make the user categorize an unfamiliar problem before describing it.

Discovery produces a draft capability after a verified successful run. The review screen explains what it does, its inputs and outputs, supported application variants, ordered steps, success checks, expected business outcomes, recovery branches, and required permissions. Replay evidence supports the decision to approve a version for unattended use.

Discovery may revise its plan as observations change. Replay displays its fixed capability version and declared branches. If replay encounters an unsupported condition, it pauses or fails according to its contract. An operator can start a separate investigation that proposes a new version; the active run does not silently acquire new behavior.

## 5. Run lifecycle and honest progress

Present the lifecycle as a sequence of observable states:

```text
Queued → Preparing session → Running → Verifying outcome → Finished
                               ↓
                      Waiting for intervention
                               ↓
                    Human control → Validating handback
```

Finished results distinguish Verified success, Expected business outcome, Technical failure, Stopped, and Outcome unconfirmed. “Customer not found” can be a legitimate result. “Outcome unconfirmed” applies when an action may have taken effect but its result could not be observed.

Show elapsed time and verified milestones. Avoid percentages when remaining work is unknown. Known waits identify their reason and applicable timeout; bounded retries show their attempt count.

Pause and Stop initially display “Request sent.” Only a worker acknowledgement changes the control state. “Paused” means no automation action remains in flight. Stopping prevents future actions; the result lists changes already verified and any unresolved effects. After an uncertain submission, offer reconciliation instead of an immediate repeat action.

## 6. Human intervention and control transfer

The Intervention Inbox provides reason, institution, application, current step, time waiting, session expiry, and ownership. Opening a request displays enough context to decide what to do before inspecting the live screen.

Use distinct intervention types:

- **Clarification:** supply a missing parameter or select an interpretation. This does not change permissions.
- **Action approval:** review one proposed action, the affected record, exact changes, and consequences. Approval binds to the action and current state, expires, and becomes invalid if relevant state changes.
- **Live takeover:** operate the same paused session after an exclusive control claim.
- **Policy review:** an authorized administrator considers a scoped permission change, with a versioned record and explicit effect on future execution.

A novel goal does not trigger a vague “add to allowlist” prompt. Human control also remains subject to the session’s enforced application boundaries.

Taking control does not bypass a required action approval. Known sensitive actions need the same one-use grant for human and automated input. Where the surface cannot enforce that distinction reliably, restrict the target account or withhold that manual mutation path. The interface must explain the supported boundary.

Takeover proceeds through Requested, Pausing automation, Ready to claim, Human controlling, Handback requested, Validating state, and Resumed. The worker grants input to one controller at a time. Display that person’s identity and disable competing input. Claim conflicts return a clear “Already controlled by…” message.

During private application login or MFA, explain which capture and observation restrictions are active. Keep secret values out of chat, capability artifacts, and recorded keystrokes.

The operator can return control, report manual completion, declare inability to complete, or stop the run. Returning control revalidates institution, application, selected record, authentication, and a known checkpoint before resuming. Manual completion is marked verified when checks establish the result; otherwise identify it as operator-attested.

Human actions remain part of the run’s evidence. A separate review action can propose a capability improvement. An abandoned claim expires safely and returns the request to the queue without allowing concurrent control.

## 7. Cloud sessions and disconnect behavior

The desktop is an operator client; cloud workers own execution and session state. Closing the window or losing connectivity must not imply that execution stopped. Show this behavior during onboarding and in the running-session controls.

On desktop disconnection, an authorized unattended replay may continue under its existing policy. A run requiring interactive control or fresh approval pauses safely. When a human controller disconnects, stop accepting their input and apply the control lease timeout; do not hand the session directly back to automation without validation.

On reconnect, restore the same run, latest worker state, control owner, outstanding request, and event position. Mark the preview stale until fresh frames arrive. Commands carry identifiers so reconnecting cannot accidentally issue them twice. If the original session has expired, explain what remains recoverable and whether the outcome requires reconciliation.

## 8. Dashboard, history, and evidence

Measure outcomes that support operations: verified replay successes, expected business outcomes, technical failures, unconfirmed outcomes, interventions, and time waiting for an operator. Separate discovery results from replay reliability. Show the sample size, period, environment, and capability version behind reliability figures.

Provide filters for institution, application, capability, outcome, and date. Each result links to the relevant run and failed expectation. Evidence includes structured actions, verification results, human interventions, and privacy-filtered visual context. If evidence capture fails or is withheld for privacy, display that fact explicitly.

The application and capability views show compatible versions, authentication readiness, disabled capabilities, and changes awaiting review. These connect dashboard symptoms to concrete corrective work.

## 9. Voice and accessibility

Voice uses push-to-talk with visible recording state, cancel, and stop controls. Present an editable transcript before submission. If interpretation is ambiguous, retain the text and ask for clarification. Approval and policy changes use their dedicated review controls.

Every essential action must work by keyboard and expose an accessible name. Provide semantic progress and intervention descriptions alongside the visual session. Do not rely on color to distinguish ownership, risk, or result. Use sufficient contrast, scalable text, reduced-motion support, predictable focus, and status announcements that avoid reading every stream update.

On smaller windows or enlarged text, turn the inspector into a drawer and retain the session toolbar and current intervention. Preserve a visible return path from focus mode. Validate macOS behavior first, then adapt Windows shortcuts and native conventions while keeping the same run and control semantics.
