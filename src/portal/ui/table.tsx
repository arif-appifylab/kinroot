import type {ReactNode} from 'react';

import {Button} from './button';
import {ErrorNote, Skeleton} from './display';

export type Column<Row> = {
  /** Unique per table. */
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  align?: 'start' | 'end';
  /** `shrink`: as narrow as its content (dates, statuses, actions). */
  width?: 'auto' | 'shrink';
  /** Hide this column on narrow screens (a secondary date, an id). */
  hideOnMobile?: boolean;
  /** The row's actions column: right-aligned, no header text, never stacked with a label. */
  actions?: boolean;
};

/**
 * THE table of the portal. It draws all three states itself, so no screen
 * forgets one: `loading` (skeleton rows), `error` (the message, in place) and
 * an `empty` state (pass an `<EmptyState>` with its call to action).
 *
 * On a phone each row becomes a card: every cell shows its column header as
 * its label (`data-label`), so nothing scrolls sideways.
 *
 * `busyKey`: the row an action is running on (`aria-busy`, dimmed): only that
 * row's buttons show pending (AGENTS.md "Per row").
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  loading,
  error,
  empty,
  busyKey,
}: {
  columns: Column<Row>[];
  rows: Row[] | undefined;
  rowKey: (row: Row) => string | number;
  /** What the table lists, for screen readers ("Users"). */
  caption: string;
  loading?: boolean;
  error?: Error | null;
  empty?: ReactNode;
  busyKey?: string | number | null;
}) {
  if (error && !rows?.length) return <ErrorNote error={error} />;
  if (!loading && rows && rows.length === 0) return <>{empty}</>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map(column => (
              <th
                key={column.key}
                scope="col"
                className={cellClass(column)}
                aria-label={column.actions ? 'Actions' : undefined}>
                {column.actions ? null : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && !rows?.length
            ? Array.from({length: 4}, (_, i) => (
                <tr key={`skeleton-${i}`} aria-hidden="true">
                  {columns.map(column => (
                    <td key={column.key} className={cellClass(column)}>
                      {column.actions ? null : <Skeleton width={i % 2 ? 'half' : 'full'} />}
                    </td>
                  ))}
                </tr>
              ))
            : rows?.map(row => {
                const key = rowKey(row);
                return (
                  <tr key={key} aria-busy={busyKey === key || undefined}>
                    {columns.map(column => (
                      <td
                        key={column.key}
                        className={cellClass(column)}
                        data-label={column.actions || typeof column.header !== 'string' ? undefined : column.header}>
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
        </tbody>
      </table>
    </div>
  );
}

const cellClass = <Row,>(column: Column<Row>) =>
  [
    column.align === 'end' || column.actions ? 'cell-end' : '',
    column.width === 'shrink' || column.actions ? 'cell-shrink' : '',
    column.hideOnMobile ? 'cell-hide-mobile' : '',
    column.actions ? 'cell-actions' : '',
  ]
    .filter(Boolean)
    .join(' ') || undefined;

/**
 * "Load more" under a keyset-paged list (`useInfiniteQuery`). Shows nothing
 * on the last page. Never page numbers: the lists are keyset-paged.
 */
export function LoadMore({
  query,
}: {
  query: {hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown};
}) {
  if (!query.hasNextPage) return null;
  return (
    <div className="load-more">
      <Button variant="secondary" pending={query.isFetchingNextPage} pendingLabel="Loading…" onClick={() => void query.fetchNextPage()}>
        Load more
      </Button>
    </div>
  );
}
