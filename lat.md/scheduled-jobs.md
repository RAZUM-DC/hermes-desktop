# Scheduled jobs

The Schedules screen presents Hermes cron jobs consistently across local files, the Remote API, and named SSH profiles.

Jobs explicitly marked `completed` keep that terminal state even though Hermes also disables them. Other disabled jobs normalize as paused. Only active jobs remain enabled, so active-only lists exclude completed and paused entries across every transport.

## Test specifications

These tests protect state normalization where Hermes cron data enters the desktop schedule model.

### Local terminal-state normalization

Reading a local jobs file preserves completed states, keeps paused and legacy-disabled jobs disabled, filters active-only results, and never rewrites stored data.

### Remote completed jobs remain completed

A disabled Remote API job whose source state is `completed` retains the completed badge and stays out of active-only results.

### Completed SSH jobs stay disabled

Named-profile SSH output retains completed states with `enabled: false`, and active-only requests exclude terminal jobs.
