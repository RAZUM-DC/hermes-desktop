# Chat message-list rendering performance

Typing in the composer must stay fast no matter how long the conversation is. CSS containment bounds layout work, while transcript windowing bounds the mounted React tree (issue #748).

The symptom this guards against: in conversations with many messages, each keystroke took up to ~2.6s because Chromium recalculated the transcript and React reconciled every row. CPU and memory were normal; new sessions were instant.

## Transcript windowing

Long conversations initially mount only the newest 100 transcript rows, keeping older history available without making every streaming update reconcile the entire session.

[[src/renderer/src/screens/Chat/MessageList.tsx#TRANSCRIPT_WINDOW]] defines the default window. Earlier rows appear through a translated button and automatically load when its marker approaches the scroll viewport. Each expansion reveals one more effective window.

The boundary preserves interaction and reading state: it never hides the newest bubble or an unresolved clarification, avoids splitting normal tool runs, consults the hidden preceding row for avatar grouping, and stays pinned while the user reads above the bottom.

Before rows are prepended, the component records `scrollHeight` and `scrollTop`; a layout effect restores the same visible content before paint. Switching conversations resets the expansion budget. [[src/renderer/src/screens/Chat/MessageList.test.tsx]] covers these invariants.

### Initial history position

Opening an existing conversation must land at its newest messages without racing the automatic history expansion marker.

[[src/renderer/src/screens/Chat/hooks/useChatScroll.ts#useChatScroll]] jumps to the bottom instantly on the first non-empty history paint. Later incoming messages retain smooth scrolling unless the reader has manually scrolled upward.

## Off-screen rows are skipped with content-visibility

Every transcript row (`.chat-message`) sets `content-visibility: auto` with `contain-intrinsic-size: auto 120px`, so the browser skips layout and paint for off-screen rows. That turns a forced reflow from O(all messages) into O(visible rows).

The rule lives on `.chat-message` in the renderer stylesheet (`src/renderer/src/assets/main.css`). That class is shared by user/agent bubbles, the reasoning and tool-activity rows, and the typing indicator (see [[src/renderer/src/screens/Chat/MessageList.tsx]] and [[src/renderer/src/screens/Chat/MessageRow.tsx]]), so one rule covers every heavy row.

The `auto` keyword in `contain-intrinsic-size` makes the browser remember each row's real measured height after it renders once, so the scrollbar and scroll position stay accurate; the `120px` is only the first-paint estimate for never-yet-rendered rows.

### Paint containment and the hover timestamp

`content-visibility` implies paint containment, which clips anything drawn outside the row's box — including the hover timestamp that sits below the bubble.

The timestamp (`.chat-bubble-time`) used to overflow ~15px below the bubble and would be clipped. It now sits at `bottom: 1px` inside the row's `padding-bottom: 16px`, so it stays visible while still appearing just under the bubble.

## Block flow, not a flex column

The scroll container `.chat-messages` is block flow, not a flex column. A flex column measures each child to lay itself out, which defeats `content-visibility` and reports a wrong `scrollHeight`.

A correct `scrollHeight` matters because [[src/renderer/src/screens/Chat/hooks/useChatScroll.ts#useChatScroll]] uses `scrollHeight - scrollTop - clientHeight` to decide whether the view is pinned to the bottom; a wrong value would break auto-scroll.

The flex `gap` that previously spaced rows is replaced by per-row spacing: `.chat-message` carries `padding-bottom: 16px` (which also provides the timestamp's room), and non-message children that lack it (`.chat-clarify`) carry an equivalent `margin-bottom`. Block flow also moves alignment from `align-self` to `margin-left: auto` for user rows, and the empty state fills height with `min-height: 100%` instead of `flex: 1`.

## Textarea auto-resize avoids per-keystroke reflow

The composer textarea auto-grows to its content. Reading `scrollHeight` to size it forces a layout flush, so it runs once per committed value in a `useLayoutEffect` keyed on the input string, not on every keystroke.

In [[src/renderer/src/screens/Chat/ChatInput.tsx]] every path that changes the value (typing, history recall, voice transcription, and the imperative `setText`/`appendText`) goes through `setInput`, so the layout effect is the single owner of resizing — the other paths only set the caret and focus. Combined with the row-level `content-visibility`, the one measurement per keystroke stays O(visible rows).

## Slash command palette uses fixed-row virtualization

Large Agent command catalogs must not make opening, filtering, scrolling, or keyboard navigation proportional to the number of mounted command elements.

[[src/renderer/src/screens/Chat/slash/virtualSlashCommands.ts#createSlashCommandVirtualLayout]] converts the filtered catalog into fixed-height category and command rows. The scroll viewport mounts only intersecting rows plus four command-row heights of overscan, found from the ordered layout with a binary search.

The fixed heights are an invariant shared with the `.slash-menu-item` and `.slash-menu-group-label` styles. Changing either visual height requires updating the corresponding layout constant so calculated scroll positions and the virtual canvas remain accurate.

Arrow-key selection does not query or measure command DOM nodes. [[src/renderer/src/screens/Chat/ChatInput.tsx]] computes the selected row's offset and adjusts the list scroll position only when that row leaves the viewport, including wraparound from the first command to the last.

The searchable name and description are normalized once when the command catalog changes rather than once per command on every keystroke. The virtual canvas uses layout and paint containment, and the modal overlay avoids backdrop blur so opening the palette does not trigger a full-window blur pass.
