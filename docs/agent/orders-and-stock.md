# Orders, bookings and stock: once, and never too many

Read this for anything that charges, books, reserves or sells something limited: a checkout, a booking, a
ticket, a seat, a coupon with a limit, a credit balance. Two things go wrong, and both lose real money:

- **The same request twice.** A double click, a retry after a lost connection, a reload. Fix: an idempotency key.
- **Two people at the same moment.** Both read "1 left", both buy. Fix: let the database decide, in one statement.

## The rules
1. Everything charged or booked carries an idempotency key. No exceptions.
2. The database decides what is left, not your code and not the cache.
3. Never read, check in code, then write. Between the read and the write, someone else writes.
4. Prove it: run the action many times at once in a test.

## 1. Idempotency keys

### Built-in payments: already done
`BuyButton`, `CheckoutSession` and `src/server/routes/checkout.ts` send a key for you: one per attempt, the same on
every retry, kept across a reload. The platform answers the same key with the same checkout, and with `paid: true`
once it's paid. Don't remove this. The answers:

| Answer | Meaning | Do this |
| --- | --- | --- |
| `{id, embedded}` | This attempt's checkout (new or the same one) | Open it |
| `{id, paid: true}` | Already paid | Go to the thanks page. Nothing was charged |
| 409 `E_SITE_PAYMENTS_IN_PROGRESS` | The first request is still starting | Keep the key. Say "try again in a moment" |
| 409 `E_SITE_PAYMENTS_IDEMPOTENCY_CONFLICT` | The key was used for a different purchase | A bug: use one key per purchase |

Calling `createCheckout` from your own route: pass `idempotencyKey`, taken from the browser. With a `customerRef` and
no key, it makes one from the buyer and the purchase that holds for 2 minutes. So a real second purchase of the same
thing in those 2 minutes needs its own key, and a guest with no key gets no protection.

### In the browser
One key per attempt. Make it when the buyer acts, keep it through retries, and drop it after a final answer.
```ts
import {attemptKey, forgetAttempt} from '../lib/idempotency';

const attempt = ['booking', slotId];   // what's being done: another slot is another attempt
const res = await siteFetch('/site-api/bookings', {
  method: 'POST',
  headers: {'content-type': 'application/json', 'idempotency-key': attemptKey(attempt)},
  body: JSON.stringify({slotId}),
});
// Same key on no answer or a 5xx. New key after success or a refusal.
if (res.status < 500) forgetAttempt(attempt);
```
An older site without `src/lib/idempotency.ts`: `crypto.randomUUID()`, kept in `sessionStorage` for the attempt.

### On the server: `idempotent()`
`src/platform/idempotency.ts` takes the key and does the work in ONE transaction, so they commit together.
```ts
import {idempotencyKeyOf, IdempotencyConflict, idempotent} from '../../platform/idempotency';

.post('/', withViewer, requireAuth, withDb, async c => {
  const key = idempotencyKeyOf(c.req.raw);
  if (!key) return c.json(problem('key_required', 'Start again.'), 400);
  const {slotId} = c.req.valid('json');
  try {
    const {value} = await idempotent(
      c.var.db,
      {scope: `booking:${c.var.viewer.id}`, key, request: {slotId}},
      tx => tx.booking.create({data: {slotId, userId: c.var.viewer.id!}, select: {id: true}})
    );
    return c.json(value, 201);
  } catch (error) {
    if (error instanceof IdempotencyConflict) return c.json(problem(error.code, 'Start again.'), 409);
    throw error;
  }
});
```
- `scope` always names who it's for (`booking:${viewer.id}`), so one person's key can't reach another's answer. For
  a guest, use the thing itself (`booking:${slotId}`) and return only an id.
- Throw inside `work` to refuse: everything rolls back and the key is free again.
- Return ids and statuses. The answer is stored for 7 days: no secrets, tokens or email addresses.
- Only database work goes inside. Never call a payment provider there: the transaction stays open while it runs.

An older site without the helper: a table with a unique `(scope, key)`, and inside a transaction
`INSERT … ON CONFLICT DO NOTHING RETURNING id`. No row back means it's a repeat: return the stored answer.

### Your own payment provider
Send its idempotency key on every call that creates a charge, refund or subscription (Stripe's `idempotencyKey`
option, a provider's `Idempotency-Key` header), made from your own stable id such as the order id
(`order:${order.id}`), never a random value per try. Save the order first, then call the provider outside any
transaction, then save the answer. A provider without keys: search for the charge by your order id before retrying.

### Hooks
Payment events and the thanks page can both report one payment, so a hook runs more than once. One-time work goes
under `if (created)` from `recordOrder`, or in a job with a `key` (`payments.md`).

## 2. Never too many

### One stock count: a conditional update
```ts
const {count} = await db.product.updateMany({
  where: {id, stock: {gte: quantity}},
  data: {stock: {decrement: quantity}},
});
if (count === 0) return c.json(problem('sold_out', 'That just sold out.'), 409);
```
One statement, so the database does the check and the change together, and 40 buyers for 5 items sell exactly 5. Add
`CHECK ("stock" >= 0)` in the migration as the backstop. Never `findUnique`, `if (stock >= quantity)`, then `update`.

Coupons with a limit, seats and credit balances work the same way: `where` holds the limit, `count === 0` means no.

### One of a thing: a unique index
A slot, a seat number, one review per person, one trial. Let the index refuse the second, and catch `P2002` → 409.
A row that can be cancelled needs a partial index, so a cancelled slot can be booked again (write it in the migration,
Prisma's schema can't say it):
```sql
CREATE UNIQUE INDEX "bookings_slot_taken" ON "bookings" ("slot_id") WHERE "status" <> 'cancelled';
```

### Time ranges that can't overlap: an exclusion constraint
A room or a person booked from 10:00 to 11:30. A unique index can't see an overlap. In the migration:
```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist ("room_id" WITH =, tsrange("starts_at", "ends_at") WITH &&) WHERE ("status" <> 'cancelled');
```
A clash fails with Postgres error `23P01`: answer 409 in words. If the database refuses the extension, use the lock below.

### A limit across many rows: a lock
"At most 3 bookings per class" when each booking is its own row: nothing to put a `where` on. Take a lock for that one
class in a short transaction, count, then insert:
```ts
await db.$transaction(async tx => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`class:${classId}`}, 0))`;
  const taken = await tx.booking.count({where: {classId, status: {not: 'cancelled'}}});
  if (taken >= limit) throw new SoldOut();
  await tx.booking.create({data: {classId, userId}});
});
```
Or lock a parent row with `SELECT … FOR UPDATE`. Keep these short: everyone for that class waits in line, and past 5 s
they fail with `P2028`. The lock ends with the transaction. Never hold one across a payment or any outside call.

### A cart with several items
Update inside one transaction, in id order (two carts in opposite order deadlock, `40P01`). Any `count === 0`: throw, so
every item goes back.

### Paying takes time: hold, then confirm
Take the stock when the buyer starts paying, not when the money arrives. Otherwise two people pay for the last one.
1. **Hold**, in `idempotent()`: the conditional update, plus an order with `status: 'held'` and `holdExpiresAt` 15
   minutes away. Return the order id.
2. **Pay**, outside the transaction: `createCheckout` with the same key and `metadata: {orderId}`.
3. **Confirm** in `onCheckoutPaid`, conditionally: `updateMany({where: {id, status: 'held'}, data: {status: 'paid'}})`.
4. **Release** on `onCheckoutFailed`, and in a job every minute for expired holds. Change the status and give the stock
   back in one transaction, conditional on `status: 'held'`, so it's only given back once.
5. **Paid after the hold was released:** try to take the stock again. If it's gone, mark the order `needs_refund` and
   email the owner (kind `notification`, no `to`). Never ignore money that arrived.

## The cache never decides
Never use the Site Cache for keys, locks, stock or "is it taken", even though it's fast and looks like Redis. It has no
atomic operations, a miss or an outage must not block a sale, and a read is about 15 ms against about 3 ms for a
query. The write goes to the database anyway, and only the database can refuse it. You may cache a "3 left" label for
display (`cache.md`), then let the conditional update decide.

## Prove it
Every one of these gets a test that runs it at once, on the real database:
```ts
const results = await Promise.all(Array.from({length: 40}, () => buy(productId)));
expect(results.filter(r => r.ok)).toHaveLength(5);
expect((await db.product.findUnique({where: {id: productId}}))!.stock).toBe(0);
```
And the same key many times at once: one row, the same answer for all. `tests/integration/idempotency.test.ts` shows both.
