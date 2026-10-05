# Demo Feature Specification

## Scope
An independent HTML prototype and application expose a named design session form.
The name is deterministic test data. Creating a session displays a confirmation with that name.
No server-side persistence, authentication, third-party integration or production deployment is involved.

## Acceptance
- The default state matches the prototype card geometry, typography and colors.
- A user can fill the session name and create a session.
- The submitted state displays the exact entered name.
- Both states pass mapped geometry, computed styles and region screenshot comparison.
- Repeatable Playwright tests execute through the test runner.

## Plan / Tasks
1. Preserve the canonical prototype.
2. Maintain the independent app HTML and its event handler.
3. Run static asset validation, Playwright functional tests and ProtoFlow visual verification.
4. Create a pending review. A real human must inspect artifacts before approval.
