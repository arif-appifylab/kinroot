---
title: UI: the dashboard's UI kit, and how every screen is built from it
read-when: before building or changing ANY dashboard screen, form, table, dialog, button or style, and before adding a component or a dependency for the UI
---
The dashboard (`/dashboard`, code in `src/portal/`) ships a finished admin look: app shell,
overview, users, roles, activity, jobs and account screens, all built from ONE kit in
`src/portal/ui/`. Build every new screen from it, so the app looks and behaves as one.
Override the look through tokens and classes; never fork a component into a screen.

**See it:** `/dashboard/components` in the Preview (dev only, never in a build) shows every
piece live. Read its code (`src/portal/screens/components.tsx`) for usage.

## The three layers
| Layer | File | Change it to… |
| --- | --- | --- |
| Tokens (colour, shadow, radius, fonts; light + dark) | `src/styles/global.css` `:root` | rebrand: `--accent` (+ `--accent-hover`, `--accent-soft`, `--accent-text`), both themes |
| Classes (shell + kit look) | `src/styles/app.css` (dashboard only) | restyle a component everywhere |
| Components (markup, a11y, behaviour) | `src/portal/ui/*.tsx`, imported from `'../ui'` | add a piece, or a prop the app needs |

- Colours ONLY via tokens (`var(--muted)`), never hex (exceptions: white knobs, QR codes).
  Every token has a dark value. `data-theme="dark" | "light"` on `<html>` forces a theme (the
  top bar's theme menu does it), otherwise the device decides.
- A screen's own CSS goes at the END of `app.css`, scoped under its root class
  (`<div className="app-page screen-orders">` → `.screen-orders .x {}`).
- NO `style={…}` / `style=""`: the CSP blocks inline styles. Sizes come from classes; charts
  draw with SVG attributes (`<rect height={h}>`). Positioning that must be computed (the `Menu`)
  is set through `element.style` in an effect, which the CSP allows.
- Never a coloured stripe on one side of a card, notice, row or menu item (left border, inset
  shadow bar). Show state with a full 1px border, a soft fill, an icon tile or a badge.
- Never a second UI library, icon pack, chart library or CSS framework. Missing a piece: add
  it to `src/portal/ui/` from the same tokens, export it from `ui/index.ts`, show it on the
  Components screen.

## The kit
| Need | Use | Rule |
| --- | --- | --- |
| Screen head | `PageHeader title description actions` | every screen; ONE primary action |
| Panel | `Card title description actions footer flush tone="danger"` | `flush` for a table/list edge to edge |
| Settings | `SettingRow title description` inside a `Card` | label left, control right; stacks on a phone |
| Numbers | `Stat label value icon hint trend to` (+ `Sparkline`) | `value={null}` = skeleton; cheap numbers only |
| Charts | `Sparkline`, `BarChart`, `ProgressBar` | SVG, theme colours, a text equivalent for screen readers |
| Table | `DataTable columns rows rowKey caption loading error empty busyKey` + `LoadMore` | loading, error, empty built in; cards on a phone |
| Person cell | `Person name detail src`, `Avatar` | first column of a people table |
| Labels | `Badge tone`, `StatusBadge tone` | map each status to a tone ONCE per screen (`STATUS_TONES`) |
| Actions | `Button variant size icon pending pendingLabel`, `IconButton label`, `buttonClass()` for a `<Link>` | primary / secondary / ghost / link / danger |
| Row actions | `Menu label items` | main action on the row, the rest (and destructive ones) in ⋯ |
| Fields | `Field` + `<input {...form.field('x')}>`, `useForm`, `rules` | label, hint, error in place; client rules = server rules |
| Choices | `RadioCards` (2–5 options), `Select` (long lists), `Checkbox`, `Switch` (applies at once) | never a native `<select>` styled by hand |
| Passwords | `PasswordInput`, `PasswordChecks` | every password field has show / hide |
| Search / filter | `SearchInput`, `SegmentedControl` in a `.toolbar` | the filter is in the query key |
| Views of one screen | `Tabs label items value onChange` | keep the tab in the URL when people link to it |
| Short task | `Modal` | invite, rename; primary button last |
| Create / edit / details | `Drawer onSubmit footer` | long forms; the drawer IS the `<form>` |
| Destructive confirm | `useConfirm()({title, body, confirmLabel, action})` | dialog stays open, pending, shows the error |
| Result of an action | `useToast().success('Job posted.')` | errors that need fixing stay in place, not in a toast |
| States | `EmptyState icon title action`, `LoadingBlock`, `Skeleton`, `Notice tone`, `ErrorNote` | every list: loading, empty (with its action), error |
| Icons | `<Icon name>` (`ICON_NAMES`) | decorative; add paths from lucide.dev to `ui/icon.tsx` |

Never `window.confirm`, `window.alert` or `prompt()` in the dashboard.

## A new screen, start to finish
1. Data: the Site API route (`site-api.md`), then its reads in `src/portal/queries.ts`
   (`queryOptions` / `infiniteQueryOptions`).
2. `src/portal/screens/orders.tsx`:
```tsx
import {useInfiniteQuery, useMutation, useQueryClient} from '@tanstack/react-query';
import {ordersQuery} from '../queries';
import {ago} from '../shared';
import {Button, Card, type Column, DataTable, EmptyState, LoadMore, Menu, PageHeader, StatusBadge, useConfirm, useToast} from '../ui';

const STATUS_TONES = {paid: 'success', pending: 'warning', refunded: 'neutral'} as const;

export function Orders() {
  const orders = useInfiniteQuery(ordersQuery);
  const rows = orders.data?.pages.flatMap(page => page.orders);
  const columns: Column<Order>[] = [
    {key: 'customer', header: 'Customer', cell: o => <span className="cell-title">{o.customer}</span>},
    {key: 'status', header: 'Status', width: 'shrink', cell: o => <StatusBadge tone={STATUS_TONES[o.status]}>{o.status}</StatusBadge>},
    {key: 'when', header: 'Placed', width: 'shrink', hideOnMobile: true, cell: o => ago(o.createdAt)},
    {key: 'actions', header: 'Actions', actions: true, cell: o => <Menu label={`Actions for order ${o.number}`} items={[/* … */]} />},
  ];
  return (
    <div className="app-page screen-orders">
      <PageHeader title="Orders" description="Every order, newest first." actions={<Button icon="plus">New order</Button>} />
      <Card flush>
        <DataTable caption="Orders" columns={columns} rows={rows} rowKey={o => o.id}
          loading={orders.isPending} error={orders.error}
          empty={<EmptyState icon="inbox" title="No orders yet">Orders show here as customers place them.</EmptyState>} />
      </Card>
      <LoadMore query={orders} />
    </div>
  );
}
```
3. The route in `src/portal/routes.tsx` (literal path, `staticData.title`, a `loader` warming
   the query, the component lazy) and its `NAV_GROUPS` item with an `icon` (and `ability`
   when gated). The top bar's `<h1>` is the route title; the screen's head is an `<h2>`.

## Patterns
- **Create / edit:** a `Drawer` with `onSubmit={form.submit(values => save.mutate(values))}`;
  footer `Cancel` (secondary, disabled while saving) + `Save` (`type="submit"`, pending). On
  success: close, invalidate the list's key, `toast.success(…)`. On a 422: `form.setServerErrors(err.fields)`.
- **Delete / suspend / revoke:** in the row's `Menu` (`danger: true`), then
  `confirm({title: 'Delete “X”?', body: 'What happens, in words.', confirmLabel: 'Delete X', action: () => remove.mutateAsync(id)})`.
- **Per row busy:** pass the acting row's id as `busyKey`; only that row dims.
- **Lists:** keyset paged, `LoadMore`; filters in the query key; search on submit, not per keystroke.
- **Overview tiles:** a first page's length (`pageCount`, "25+") or a counter kept on write;
  never `count()` per request (`performance.md`).
- **Settings screen:** one `Card` per topic, `SettingRow`s inside, Save in the card's `footer`.
- **Danger zone:** the last card, `tone="danger"`, a typed confirmation for what cannot be undone.
- **Gated UI:** hide with `abilities` (`me.data?.abilities.x`); the route's guard is the enforcement.

## Accessibility (checked before done)
- Every control has a visible label or `aria-label` (`IconButton label` is required).
- Focus is visible everywhere (the kit's rings); dialogs trap and return focus; Esc closes.
- `Tabs`, `SegmentedControl` and `Menu` move with the arrow keys; don't rebuild them.
- Colour is never the only signal: a `StatusBadge` has its word, a chart has its numbers.
- Check the screen at 1440 and 390 wide, light and dark: no sideways scroll, nothing cut off.
