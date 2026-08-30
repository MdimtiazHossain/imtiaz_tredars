import { C, MONO } from '../styles/tokens.js';

/**
 * Model builders for the reusable form modal.
 *
 * The design drew one modal — "New customer" on the dealer sales screen — and
 * this generalises that exact treatment so payments, expenses and stock
 * adjustments look like part of the product rather than three separate
 * inventions. Same overlay, same header, same footer, same field styling.
 *
 * Like the DataTable, it is driven entirely by the object `formModal()`
 * returns, so no screen is coupled to it.
 */

/**
 * Build one field.
 *
 * @param {string} key          identifies the field to the caller's onChange
 * @param {string} label
 * @param {object} [o]
 * @param {'text'|'number'|'date'} [o.type='text']
 * @param {Array}  [o.options]  present for a select: `{value, label}` or strings
 * @param {*}      [o.value]
 * @param {Function} [o.onChange]
 * @param {string} [o.placeholder]
 * @param {string} [o.hint]     small note under the control
 * @param {boolean}[o.mono]     monospace, for figures and codes
 * @param {boolean}[o.wide]     span the whole grid rather than one column
 */
export function field(key, label, o = {}) {
  const isSelect = Array.isArray(o.options);
  return {
    key,
    label,
    isSelect,
    // The template picks exactly one branch; a select is not also a text input.
    isText: !isSelect,
    inputType: o.type || 'text',
    value: o.value === undefined || o.value === null ? '' : o.value,
    options: isSelect
      ? o.options.map((opt) =>
          typeof opt === 'string' ? { value: opt, label: opt } : opt
        )
      : [],
    onChange: o.onChange || null,
    placeholder: o.placeholder || '',
    hint: o.hint || '',
    font: o.mono || o.type === 'number' ? MONO : 'inherit',
    // `grid-column` takes the whole row for a wide field, one track otherwise.
    span: o.wide ? '1 / -1' : 'auto',
  };
}

/**
 * Build the modal model.
 *
 * @param {object} o
 * @param {boolean} o.open
 * @param {string}  o.title
 * @param {string}  [o.subtitle]
 * @param {Array}   o.fields        from `field()`
 * @param {Array}   [o.summary]     `{k, v, good}` rows shown above the footer
 * @param {string}  [o.error]       validation message, shown in a banner
 * @param {boolean} [o.busy]        disables submit while saving
 * @param {string}  [o.submitLabel]
 * @param {string}  [o.note]        quiet footer text
 * @param {string}  [o.width='620px']
 * @param {Function} o.onSubmit
 * @param {Function} o.onCancel
 */
export function formModal(o) {
  const busy = !!o.busy;
  return {
    open: !!o.open,
    title: o.title,
    subtitle: o.subtitle || '',
    fields: o.fields || [],
    summary: (o.summary || []).map((s) => ({
      k: s.k,
      v: s.v,
      color: s.good === false ? C.dngr : s.good === true ? C.crop : C.ink,
    })),
    error: o.error || '',
    busy,
    submitLabel: busy ? 'Saving…' : o.submitLabel || 'Save',
    cursor: busy ? 'not-allowed' : 'pointer',
    opacity: busy ? '0.7' : '1',
    note: o.note || '',
    width: o.width || '620px',
    onSubmit: busy ? null : o.onSubmit,
    onCancel: o.onCancel,
  };
}
