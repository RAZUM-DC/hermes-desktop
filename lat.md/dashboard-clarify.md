# Dashboard clarification

The desktop preserves structured gateway questions as interactive cards and returns answers through the connection that created them.

## Interactive questions

[[src/renderer/src/screens/Chat/dashboardEventAdapter.ts#appendClarifyRequest]] converts `clarify.request` events into dashboard-tagged cards, retaining the question, choices and request id instead of flattening them into assistant text.

[[src/renderer/src/screens/Chat/ClarifyCard.tsx]] supports choice buttons, free text and an empty skip answer. [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] routes dashboard cards to the WebSocket transport while local gateway cards continue to use IPC.

## Answer lifecycle

[[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]] accepts an answer only for the pending request on the current runtime session and only marks it resolved after `clarify.respond` returns `status: ok`.

Concurrent replies are rejected, failed delivery remains retryable, and the composer uses the same responder as the card. Session or connection changes, completion, abort, teardown and socket closure invalidate stale questions so an answer cannot leak into another session.

## Expiration and replay

`clarify.expire` disables only its matching card and restores the original active turn while the agent resumes after timeout.

Replayed requests cannot reopen answered or unavailable cards. A late reply acknowledgement resolves its original card without clearing a newer pending question.

## Verification

Focused tests cover structured event adaptation, card transport routing, choice/free-text/skip answers, duplicate suppression, retry, expiration, disconnect and connection isolation.

The coverage lives in [[src/renderer/src/screens/Chat/ClarifyCard.test.tsx]], [[src/renderer/src/screens/Chat/dashboardEventAdapter.test.ts]], [[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.test.tsx]] and [[tests/dashboard-event-adapter.test.ts]].
