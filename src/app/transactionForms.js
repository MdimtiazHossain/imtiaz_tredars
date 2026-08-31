import { field, formModal, allocation, lineEntry } from '../components/formModal.js';
import { money } from '../domain/format.js';

/**
 * Payment, expense and stock-adjustment forms.
 *
 * The imported design never drew these, though its dashboard offers "Receive
 * Payment", "Pay Supplier" and "Add Expense" as quick actions and its APIs
 * have always supported them. They are built from the design's own modal
 * treatment rather than invented, so they read as part of the product.
 *
 * Each form is described here as data — defaults, fields, validation, and the
 * payload to send — so `logic.js` only has to open, edit, validate and submit
 * without knowing what any particular form contains.
 */

const today = '2026-08-28';

/**
 * Quantities are held as text in the form and as numeric in the database, so
 * subtracting them yields the usual binary-fraction noise — 21.6 - 6 comes out
 * as 15.600000000000001. Three decimals matches the schema's numeric(18,3).
 */
const qty = (value) => {
  const n = Number(value) || 0;
  return String(Number(n.toFixed(3)));
};

/**
 * Payment methods still in use.
 *
 * A retired method stays on the settings screen so it can be brought back, but
 * offering it on a new payment would let money be booked through something the
 * business has stopped using.
 */
const activeMethods = (data) => (data.paymentMethods || []).filter((m) => m.active !== false);

const asOptions = (rows, valueKey, labelKey) =>
  rows.map((r) => ({ value: String(r[valueKey]), label: r[labelKey] }));

/**
 * One string that names a document across the four tables it could be in.
 *
 * A select carries a string, and an id alone is ambiguous: dealer sale 14 and
 * crop purchase 14 both exist. The type travels with it.
 */
export const docKey = (d) => `${d.sourceType}:${d.sourceId}`;

/* --------------------------------------------------------------- defaults */

/** The master list a party type selects from. */
function partyList(partyType, data) {
  if (partyType === 'SUPPLIER') return data.suppliers;
  if (partyType === 'COMPANY') return data.companies;
  return data.customers;
}

export function defaultsFor(kind, data, seed = {}) {
  if (kind === 'payment') {
    const partyType = seed.partyType || 'CUSTOMER';
    // Pick the first party of the *selected* type. Defaulting to a customer
    // regardless would leave "Pay supplier" pointing at one, and the payload
    // lookup would then find nothing.
    const first = partyList(partyType, data)[0];
    return {
      direction: seed.direction || 'RECEIPT',
      partyType,
      party: seed.party || (first && first.code) || '',
      date: today,
      accountId: String(data.accounts?.[0]?.id ?? ''),
      methodId: String(activeMethods(data)[0]?.id ?? ''),
      amount: '',
      reference: '',
      note: '',
      // Invoice key -> amount, filled in by the allocation table.
      allocated: {},
    };
  }

  if (kind === 'return') {
    // A return is always against a document, so the picker starts on whichever
    // one the operator arrived from -- or on nothing, waiting for a choice.
    return {
      date: seed.date || today,
      sourceType: seed.sourceType || 'dealer_sales',
      source: seed.source || '',
      reason: '',
      // Source line key -> quantity coming back, filled in by the line table.
      quantities: {},
    };
  }

  if (kind === 'note') {
    const partyType = seed.partyType || 'CUSTOMER';
    const first = partyList(partyType, data)[0];
    return {
      date: today,
      noteType: seed.noteType || 'CREDIT',
      partyType,
      party: seed.party || (first && first.code) || '',
      businessType: seed.businessType || 'DEALER',
      amount: '',
      reason: '',
    };
  }

  if (kind === 'expense') {
    return {
      date: today,
      categoryId: String(data.expenseCategories?.[0]?.id ?? ''),
      businessType: 'SHARED',
      accountId: String(data.accounts?.[0]?.id ?? ''),
      amount: '',
      note: '',
    };
  }

  if (kind === 'transfer') {
    return {
      date: today,
      businessType: 'BULK_CROP',
      // Default to two different warehouses; moving stock to where it already
      // is has no meaning, and the server rejects it.
      fromWarehouse: data.warehouses[0] || '',
      toWarehouse: data.warehouses[1] || data.warehouses[0] || '',
      itemType: 'CROP_BATCH',
      item: (data.batches[0] && data.batches[0].id) || '',
      quantity: '',
      note: '',
    };
  }

  return {
    date: today,
    warehouse: data.warehouses[0] || '',
    businessType: 'BULK_CROP',
    itemType: 'CROP_BATCH',
    item: (data.batches[0] && data.batches[0].id) || '',
    quantityDelta: '',
    unitCost: '',
    reason: '',
  };
}

/** Options for an item selector, given the stock kind. */
function itemOptions(itemType, data) {
  return itemType === 'CROP_BATCH'
    ? data.batches.map((b) => ({ value: b.id, label: `${b.id} — ${b.crop} (${b.wh})` }))
    : asOptions(data.products, 'code', 'name');
}

/* ------------------------------------------------------------- party lists */

/** The party list a payment can be raised against, given its type. */
function partyOptions(form, data) {
  return asOptions(partyList(form.partyType, data), 'code', 'name');
}

/** What the selected party currently owes, or is owed. */
function partyBalance(form, data) {
  const party = partyList(form.partyType, data).find((p) => p.code === form.party);
  if (!party) return null;
  // Companies carry a signed balance; the other masters carry `out`.
  return party.out !== undefined ? party.out : Math.abs(party.bal || 0);
}

/* ------------------------------------------------------------ field lists */

export function fieldsFor(kind, form, data, onChange) {
  const on = (key) => onChange(key);

  if (kind === 'payment') {
    const outstanding = partyBalance(form, data);
    return [
      field('direction', 'Direction', {
        options: [
          { value: 'RECEIPT', label: 'Receipt — money in' },
          { value: 'PAYMENT', label: 'Payment — money out' },
        ],
        value: form.direction,
        onChange: on('direction'),
      }),
      field('date', 'Date', { type: 'date', value: form.date, onChange: on('date') }),
      field('partyType', 'Party type', {
        options: [
          { value: 'CUSTOMER', label: 'Customer' },
          { value: 'SUPPLIER', label: 'Supplier / farmer' },
          { value: 'COMPANY', label: 'Company' },
        ],
        value: form.partyType,
        onChange: on('partyType'),
      }),
      field('party', 'Party', {
        options: partyOptions(form, data),
        value: form.party,
        onChange: on('party'),
        hint: outstanding === null ? '' : `Outstanding ${money(outstanding)}`,
      }),
      field('accountId', 'Account', {
        options: asOptions(data.accounts || [], 'id', 'name'),
        value: form.accountId,
        onChange: on('accountId'),
      }),
      field('methodId', 'Method', {
        options: asOptions(activeMethods(data), 'id', 'name'),
        value: form.methodId,
        onChange: on('methodId'),
      }),
      field('amount', 'Amount', {
        type: 'number',
        value: form.amount,
        onChange: on('amount'),
        placeholder: '0',
      }),
      field('reference', 'Reference', {
        value: form.reference,
        onChange: on('reference'),
        placeholder: 'Cheque or transaction number',
      }),
      field('note', 'Note', { value: form.note, onChange: on('note'), wide: true }),
    ];
  }

  if (kind === 'return') {
    const source = (data.returnableDocs || []).find((d) => docKey(d) === form.source);
    return [
      field('sourceType', 'Returning against', {
        options: [
          { value: 'dealer_sales', label: 'Dealer sale — customer sent goods back' },
          { value: 'crop_sales', label: 'Crop sale — buyer sent goods back' },
          { value: 'dealer_purchases', label: 'Dealer purchase — going back to the principal' },
          { value: 'crop_purchases', label: 'Crop purchase — going back to the farmer' },
        ],
        value: form.sourceType,
        onChange: on('sourceType'),
        wide: true,
      }),
      field('source', 'Document', {
        options: (data.returnableDocs || []).map((d) => ({
          value: docKey(d),
          label: `${d.txnNo} — ${d.partyName}`,
        })),
        value: form.source,
        onChange: on('source'),
        hint: source ? `${money(source.netAmount)} on the original` : 'Nothing posted to return against',
        wide: true,
      }),
      field('date', 'Date', { type: 'date', value: form.date, onChange: on('date') }),
      field('reason', 'Reason', {
        value: form.reason,
        onChange: on('reason'),
        placeholder: 'Why the goods came back',
        wide: true,
      }),
    ];
  }

  if (kind === 'note') {
    const isCredit = form.noteType === 'CREDIT';
    return [
      field('noteType', 'Note', {
        options: [
          { value: 'CREDIT', label: 'Credit note — a customer owes us less' },
          { value: 'DEBIT', label: 'Debit note — we owe a supplier less' },
        ],
        value: form.noteType,
        onChange: on('noteType'),
        wide: true,
      }),
      field('date', 'Date', { type: 'date', value: form.date, onChange: on('date') }),
      field('partyType', 'Party type', {
        options: isCredit
          ? [
              { value: 'CUSTOMER', label: 'Customer' },
              { value: 'COMPANY', label: 'Buyer company' },
            ]
          : [
              { value: 'SUPPLIER', label: 'Supplier / farmer' },
              { value: 'COMPANY', label: 'Principal company' },
            ],
        value: form.partyType,
        onChange: on('partyType'),
      }),
      field('party', 'Party', {
        options: partyOptions(form, data),
        value: form.party,
        onChange: on('party'),
      }),
      field('businessType', 'Business', {
        options: [
          { value: 'DEALER', label: 'Dealer' },
          { value: 'BULK_CROP', label: 'Bulk crop' },
        ],
        value: form.businessType,
        onChange: on('businessType'),
      }),
      field('amount', 'Amount', {
        type: 'number',
        value: form.amount,
        onChange: on('amount'),
        placeholder: '0',
      }),
      field('reason', 'Reason', {
        value: form.reason,
        onChange: on('reason'),
        placeholder: 'A price agreed after invoicing, or an allowance for damage',
        wide: true,
      }),
    ];
  }

  if (kind === 'expense') {
    return [
      field('date', 'Date', { type: 'date', value: form.date, onChange: on('date') }),
      field('categoryId', 'Category', {
        options: asOptions(data.expenseCategories || [], 'id', 'name'),
        value: form.categoryId,
        onChange: on('categoryId'),
      }),
      field('businessType', 'Business', {
        options: [
          { value: 'SHARED', label: 'Shared' },
          { value: 'DEALER', label: 'Dealer' },
          { value: 'BULK_CROP', label: 'Bulk Crop' },
        ],
        value: form.businessType,
        onChange: on('businessType'),
        hint: 'Shared expenses are not attributed to either line',
      }),
      field('accountId', 'Paid from', {
        options: asOptions(data.accounts || [], 'id', 'name'),
        value: form.accountId,
        onChange: on('accountId'),
      }),
      field('amount', 'Amount', {
        type: 'number',
        value: form.amount,
        onChange: on('amount'),
        placeholder: '0',
      }),
      field('note', 'Note', {
        value: form.note,
        onChange: on('note'),
        placeholder: 'Dinajpur to Bogura, 3 trucks',
        wide: true,
      }),
    ];
  }

  if (kind === 'transfer') {
    const selected = data.batches.find((b) => b.id === form.item);
    return [
      field('date', 'Date', { type: 'date', value: form.date, onChange: on('date') }),
      field('businessType', 'Business', {
        options: [
          { value: 'BULK_CROP', label: 'Bulk Crop' },
          { value: 'DEALER', label: 'Dealer' },
        ],
        value: form.businessType,
        onChange: on('businessType'),
      }),
      field('fromWarehouse', 'From warehouse', {
        options: data.warehouses,
        value: form.fromWarehouse,
        onChange: on('fromWarehouse'),
      }),
      field('toWarehouse', 'To warehouse', {
        options: data.warehouses,
        value: form.toWarehouse,
        onChange: on('toWarehouse'),
      }),
      field('itemType', 'Stock kind', {
        options: [
          { value: 'CROP_BATCH', label: 'Bulk crop batch' },
          { value: 'PRODUCT', label: 'Dealer product' },
        ],
        value: form.itemType,
        onChange: on('itemType'),
      }),
      field('item', form.itemType === 'CROP_BATCH' ? 'Batch' : 'Product', {
        options: itemOptions(form.itemType, data),
        value: form.item,
        onChange: on('item'),
        hint: selected ? `${qty(selected.rem)} available` : '',
      }),
      field('quantity', 'Quantity to move', {
        type: 'number',
        value: form.quantity,
        onChange: on('quantity'),
        placeholder: '0',
        hint:
          form.itemType === 'CROP_BATCH'
            ? 'Moving part of a batch splits it, keeping its cost and age'
            : '',
      }),
      field('note', 'Note', { value: form.note, onChange: on('note'), wide: true }),
    ];
  }

  const isBatch = form.itemType === 'CROP_BATCH';
  return [
    field('date', 'Date', { type: 'date', value: form.date, onChange: on('date') }),
    field('warehouse', 'Warehouse', {
      options: data.warehouses,
      value: form.warehouse,
      onChange: on('warehouse'),
    }),
    field('itemType', 'Stock kind', {
      options: [
        { value: 'CROP_BATCH', label: 'Bulk crop batch' },
        { value: 'PRODUCT', label: 'Dealer product' },
      ],
      value: form.itemType,
      onChange: on('itemType'),
    }),
    field('item', isBatch ? 'Batch' : 'Product', {
      options: isBatch
        ? data.batches.map((b) => ({ value: b.id, label: `${b.id} — ${b.crop}` }))
        : asOptions(data.products, 'code', 'name'),
      value: form.item,
      onChange: on('item'),
    }),
    field('quantityDelta', 'Change in quantity', {
      type: 'number',
      value: form.quantityDelta,
      onChange: on('quantityDelta'),
      placeholder: '-4',
      hint: 'Negative reduces stock, positive increases it',
    }),
    field('unitCost', 'Value per unit', {
      type: 'number',
      value: form.unitCost,
      onChange: on('unitCost'),
      placeholder: '0',
    }),
    field('reason', 'Reason', {
      value: form.reason,
      onChange: on('reason'),
      placeholder: 'Weight loss on Paddy batch',
      wide: true,
    }),
  ];
}

/* ------------------------------------------------------------- validation */

/** @returns {string|null} the first problem, or null when the form is good */
export function validate(kind, form) {
  const amount = Number(form.amount);

  if (kind === 'payment') {
    if (!form.party) return 'Choose the party this payment is for.';
    if (!form.accountId) return 'Choose the account the money moves through.';
    if (!(amount > 0)) return 'Enter an amount greater than zero.';

    const allocated = Object.values(form.allocated || {}).reduce(
      (t, v) => t + (Number(v) || 0),
      0
    );
    if (allocated > amount) {
      return 'Allocated more than the payment itself. Reduce a line, or raise the amount.';
    }
    return null;
  }

  if (kind === 'return') {
    if (!form.source) return 'Choose the document the goods are coming back from.';
    if (!String(form.reason || '').trim()) return 'Say why the goods came back.';
    const returning = Object.values(form.quantities || {}).reduce(
      (t, v) => t + (Number(v) || 0),
      0
    );
    if (!(returning > 0)) return 'Enter how much of at least one line is coming back.';
    return null;
  }

  if (kind === 'note') {
    if (!form.party) return 'Choose the party the note is for.';
    if (!(amount > 0)) return 'Enter an amount greater than zero.';
    if (!String(form.reason || '').trim()) return 'Say what the note is for.';
    return null;
  }

  if (kind === 'expense') {
    if (!form.categoryId) return 'Choose an expense category.';
    if (!(amount > 0)) return 'Enter an amount greater than zero.';
    return null;
  }

  if (kind === 'transfer') {
    const quantity = Number(form.quantity);
    if (form.fromWarehouse === form.toWarehouse) {
      return 'Choose two different warehouses; stock cannot move to where it already is.';
    }
    if (!form.item) return 'Choose the item to move.';
    if (!(quantity > 0)) return 'Enter a quantity greater than zero.';
    return null;
  }

  const delta = Number(form.quantityDelta);
  if (!form.item) return 'Choose the item to adjust.';
  if (!delta) return 'Enter how much the quantity changes; zero is not an adjustment.';
  if (!form.reason.trim()) return 'Give a reason — an unexplained stock change is never posted.';
  return null;
}

/* ---------------------------------------------------------------- summary */

/** The figures shown above the footer, so the effect is visible before saving. */
export function summaryFor(kind, form, data, lines) {
  if (kind === 'payment') {
    const outstanding = partyBalance(form, data);
    const amount = Number(form.amount) || 0;
    if (outstanding === null || !amount) return [];
    const after = outstanding - amount;
    const rows = [
      { k: 'Outstanding now', v: money(outstanding) },
      { k: 'This payment', v: money(amount) },
    ];

    // Paying more than is owed leaves the party in credit. Reporting that as a
    // negative outstanding reads like a mistake, so it is named for what it is.
    if (after < 0) {
      rows.push({ k: 'Settled, leaving on account', v: money(-after), good: true });
    } else {
      rows.push({ k: 'Outstanding after', v: money(after), good: after === 0 });
    }
    return rows;
  }

  if (kind === 'transfer') {
    const quantity = Number(form.quantity) || 0;
    const batch = data.batches.find((b) => b.id === form.item);
    if (!quantity || !batch) return [];
    const left = batch.rem - quantity;
    return [
      { k: 'Available in source', v: qty(batch.rem) },
      { k: 'Moving', v: qty(quantity) },
      { k: 'Left behind', v: qty(left), good: left >= 0 },
    ];
  }

  if (kind === 'return') {
    if (!lines || !lines.length) return [];
    let value = 0;
    let count = 0;
    for (const line of lines) {
      const quantity = Number((form.quantities || {})[String(line.sourceItemId)]) || 0;
      if (quantity <= 0) continue;
      count += 1;
      value += quantity * line.rate * (1 - (line.discountPct || 0) / 100);
    }
    if (!count) return [];

    const isSale = form.sourceType === 'dealer_sales' || form.sourceType === 'crop_sales';
    return [
      { k: 'Lines coming back', v: String(count) },
      { k: isSale ? 'Credit note' : 'Debit note', v: money(value), good: true },
      {
        k: isSale ? 'Customer will owe' : 'We will owe',
        v: money(value) + ' less',
      },
    ];
  }

  if (kind === 'note') {
    const amount = Number(form.amount) || 0;
    const outstanding = partyBalance(form, data);
    if (!amount) return [];
    const rows = [{ k: form.noteType === 'CREDIT' ? 'Credit note' : 'Debit note', v: money(amount) }];
    if (outstanding !== null) {
      const after = outstanding - amount;
      rows.unshift({ k: 'Outstanding now', v: money(outstanding) });
      // More credit than there is invoice leaves the party in credit, which is
      // a real position rather than a negative balance.
      rows.push(
        after < 0
          ? { k: 'Settled, leaving on account', v: money(-after), good: true }
          : { k: 'Outstanding after', v: money(after), good: after === 0 }
      );
    }
    return rows;
  }

  if (kind === 'adjustment') {
    const delta = Number(form.quantityDelta) || 0;
    const value = delta * (Number(form.unitCost) || 0);
    if (!delta) return [];
    return [
      { k: 'Quantity change', v: (delta > 0 ? '+' : '') + qty(delta) },
      { k: 'Value change', v: money(value), good: delta > 0 },
    ];
  }

  return [];
}

/* ----------------------------------------------------------------- payload */

/** Turn a completed form into the body its API endpoint expects. */
export function payloadFor(kind, form, data) {
  if (kind === 'payment') {
    const party = partyList(form.partyType, data).find((p) => p.code === form.party);

    return {
      txnDate: form.date,
      direction: form.direction,
      // A receipt from a customer is dealer business; paying a farmer is crop.
      businessType: form.partyType === 'SUPPLIER' ? 'BULK_CROP' : 'DEALER',
      partyType: form.partyType,
      partyId: party?.id,
      accountId: Number(form.accountId),
      paymentMethodId: form.methodId ? Number(form.methodId) : undefined,
      amount: Number(form.amount),
      referenceNo: form.reference || undefined,
      note: form.note || undefined,
      // Only lines the user actually filled in; the rest stays on account.
      allocations: Object.entries(form.allocated || {})
        .map(([key, value]) => {
          const [invoiceType, invoiceId] = key.split(':');
          return { invoiceType, invoiceId: Number(invoiceId), amount: Number(value) || 0 };
        })
        .filter((a) => a.amount > 0),
    };
  }

  if (kind === 'return') {
    const [sourceType, sourceId] = String(form.source).split(':');
    return {
      txnDate: form.date,
      sourceType,
      sourceId: Number(sourceId),
      reason: form.reason.trim(),
      // Only the lines actually filled in; a blank row is not a return of zero.
      lines: Object.entries(form.quantities || {})
        .map(([sourceItemId, quantity]) => ({
          sourceItemId: Number(sourceItemId),
          quantity: Number(quantity) || 0,
        }))
        .filter((l) => l.quantity > 0),
      action: 'POST',
    };
  }

  if (kind === 'note') {
    const party = partyList(form.partyType, data).find((p) => p.code === form.party);
    return {
      noteDate: form.date,
      noteType: form.noteType,
      businessType: form.businessType,
      partyType: form.partyType,
      partyId: party?.id,
      amount: Number(form.amount),
      reason: form.reason.trim(),
    };
  }

  if (kind === 'expense') {
    return {
      txnDate: form.date,
      // The API treats a null business type as shared across both lines.
      businessType: form.businessType === 'SHARED' ? null : form.businessType,
      categoryId: Number(form.categoryId),
      accountId: form.accountId ? Number(form.accountId) : undefined,
      amount: Number(form.amount),
      note: form.note || undefined,
    };
  }

  if (kind === 'transfer') {
    const isCrop = form.itemType === 'CROP_BATCH';
    const batch = isCrop ? data.batches.find((b) => b.id === form.item) : null;
    const product = isCrop ? null : data.products.find((p) => p.code === form.item);

    return {
      txnDate: form.date,
      businessType: form.businessType,
      fromWarehouseId: data.warehouseIds?.[form.fromWarehouse],
      toWarehouseId: data.warehouseIds?.[form.toWarehouse],
      note: form.note || undefined,
      lines: [
        {
          itemType: form.itemType,
          batchId: isCrop ? batch?.dbId : undefined,
          productId: isCrop ? undefined : product?.id,
          quantity: Number(form.quantity),
        },
      ],
    };
  }

  const isBatch = form.itemType === 'CROP_BATCH';
  const batch = isBatch ? data.batches.find((b) => b.id === form.item) : null;
  const product = isBatch ? null : data.products.find((p) => p.code === form.item);
  const warehouse = data.warehouseIds?.[form.warehouse];

  return {
    txnDate: form.date,
    warehouseId: warehouse,
    businessType: form.businessType,
    reason: form.reason.trim(),
    lines: [
      {
        itemType: form.itemType,
        batchId: isBatch ? batch?.dbId : undefined,
        productId: isBatch ? undefined : product?.id,
        quantityDelta: Number(form.quantityDelta),
        unitCost: Number(form.unitCost) || 0,
      },
    ],
  };
}

/* ------------------------------------------------------------------ modal */

const TITLES = {
  payment: ['Record a payment', 'Money received from a customer, or paid to a supplier'],
  expense: ['Add an expense', 'Booked against a category and, optionally, one business line'],
  adjustment: ['Adjust stock', 'Every adjustment is explained, and goes for approval'],
  transfer: ['Transfer stock', 'Move stock between warehouses; cost and age travel with it'],
  return: ['Record a return', 'Part of a posted document coming back, and the note that settles it'],
  note: ['Issue a note', 'An adjustment with no goods behind it: a price agreed, or an allowance'],
};

const SUBMIT = {
  payment: 'Record payment',
  expense: 'Save expense',
  adjustment: 'Submit adjustment',
  transfer: 'Post transfer',
  return: 'Post return',
  note: 'Issue note',
};

const NOTES = {
  payment: 'Voucher number is generated automatically',
  expense: 'Posted straight to the cash book unless it exceeds the approval limit',
  adjustment: 'Stock moves only once the adjustment is approved',
  transfer: 'Stock leaves one warehouse and arrives at the other as one action',
  return: 'Stock, the ledger and the party balance all move as one action',
  note: 'Applied to the party balance; anything it cannot absorb stays on account',
};

/** What the selected quantities come to, at the rates on the original. */
function returnValue(state, fallback) {
  const lines = state.lines || [];
  let value = 0;
  for (const line of lines) {
    const quantity = Number((state.form.quantities || {})[String(line.sourceItemId)]) || 0;
    value += quantity * line.rate * (1 - (line.discountPct || 0) / 100);
  }
  return value || fallback;
}

/** Build the modal model for whichever form is open. */
export function buildModal(app) {
  const state = app.state.modal;
  if (!state) return { open: false, fields: [], summary: [] };

  const [title, subtitle] = TITLES[state.kind];

  return formModal({
    open: true,
    title,
    subtitle,
    fields: fieldsFor(state.kind, state.form, app.data, (key) => app.onFormField(key)),
    // The same panel serves two jobs: a payment spreads money across invoices,
    // a return counts goods against what is still owed back.
    allocation:
      state.kind === 'payment' && state.invoices
        ? allocation({
            title:
              state.form.direction === 'RECEIPT'
                ? 'Apply to open invoices'
                : 'Apply to open bills',
            invoices: state.invoices,
            allocated: state.form.allocated,
            amount: state.form.amount,
            formatMoney: money,
            onChange: (key, value) => app.onAllocationChange(key, value),
            onAuto: () => app.autoAllocate(),
          })
        : state.kind === 'return' && state.lines
          ? lineEntry({
              title: 'What is coming back',
              rows: state.lines.map((l) => ({
                key: String(l.sourceItemId),
                label: l.description,
                detail:
                  `${qty(l.quantityReturnable)} of ${qty(l.quantity)} left · ` +
                  `${money(l.rate)} each`,
                limit: l.quantityReturnable,
                limitText: qty(l.quantityReturnable),
              })),
              entered: state.form.quantities,
              autoLabel: 'Take everything left',
              onChange: (key, value) => app.onReturnLine(key, value),
              onAuto: () => app.returnEverything(),
              emptyNote: state.linesLoading
                ? 'Reading the document…'
                : 'Nothing on this document is still returnable.',
              footNote: (total) =>
                total ? `${qty(total)} coming back` : 'Nothing selected yet',
              footTotal: (total) => (total ? money(returnValue(state, total)) : ''),
            })
          : null,
    summary: summaryFor(state.kind, state.form, app.data, state.lines),
    error: state.error,
    busy: state.busy,
    submitLabel: SUBMIT[state.kind],
    note: NOTES[state.kind],
    onSubmit: () => app.submitForm(),
    onCancel: () => app.closeForm(),
  });
}

/**
 * Spread a payment across open invoices, oldest first.
 *
 * The same rule the stock side uses: settle what has been waiting longest.
 * Returns the allocation map rather than mutating, so the caller decides when
 * it takes effect.
 */
export function autoAllocate(invoices, amount) {
  let left = Number(amount) || 0;
  const allocated = {};

  const oldestFirst = [...(invoices || [])].sort((a, b) =>
    String(a.dueDate || '').localeCompare(String(b.dueDate || ''))
  );

  for (const invoice of oldestFirst) {
    if (left <= 0) break;
    const take = Math.min(left, Number(invoice.balance) || 0);
    if (take <= 0) continue;
    allocated[`${invoice.invoiceType}:${invoice.invoiceId}`] = take;
    left -= take;
  }

  return allocated;
}
