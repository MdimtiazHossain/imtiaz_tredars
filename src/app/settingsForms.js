import { field, formModal } from '../components/formModal.js';

/**
 * Settings forms: the company profile, financial years, document numbering,
 * approval limits and notification rules.
 *
 * Same shape as `masterForms.js` and `transactionForms.js` -- one description
 * per kind, and the modal, the validator and the payload are built from it, so
 * a panel that becomes editable is a description rather than a new modal.
 *
 * Everything these forms offer comes from the settings payload the repository
 * returned. Nothing is listed here that the server would not accept.
 */

const KINDS = {
  company: ['Company profile', 'What appears on invoices, vouchers and reports'],
  fiscalYear: ['financial year', 'Bangladesh financial years run July to June'],
  numbering: ['numbering', 'Documents numbered from here on take the new pattern'],
  limit: ['approval limit', 'Crossing the limit routes the transaction for approval'],
  notification: ['notification rule', 'When this alert fires, and to whom it matters'],
};

/** The empty form for this kind, or the values of the record being edited. */
export function defaultsFor(kind, row) {
  if (kind === 'company') {
    return {
      name: row.name || '',
      systemName: row.systemName || '',
      tradeLicenceNo: row.tradeLicenceNo || '',
      binNo: row.binNo || '',
      headOffice: row.headOffice || '',
      mobile: row.mobile || '',
      email: row.email || '',
      currency: row.currency || 'BDT',
      defaultDistrict: row.defaultDistrict || '',
    };
  }

  if (kind === 'fiscalYear') {
    // A new year picks up where the latest one ended, which is what it almost
    // always is; the operator only corrects it when the business changed.
    const from = row?.nextStart || '';
    return { code: row?.nextCode || '', startsOn: from, endsOn: row?.nextEnd || '', current: 'no' };
  }

  if (kind === 'numbering') {
    return { prefix: row.prefix || '', padding: row.padding ?? 3 };
  }

  if (kind === 'limit') {
    return { threshold: row.threshold ?? '', active: row.active ? 'yes' : 'no' };
  }

  return { threshold: row.threshold ?? '', active: row.active ? 'yes' : 'no' };
}

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

/** The fields the modal shows, in the order they read. */
export function fieldsFor(kind, form, row, on, districts) {
  if (kind === 'company') {
    return [
      field('name', 'Company name', { value: form.name, onChange: on('name'), wide: true }),
      field('systemName', 'System name', {
        value: form.systemName,
        onChange: on('systemName'),
        hint: 'Shown under the company name in the sidebar',
      }),
      field('tradeLicenceNo', 'Trade licence no', {
        value: form.tradeLicenceNo,
        onChange: on('tradeLicenceNo'),
        mono: true,
      }),
      field('binNo', 'BIN / VAT registration', {
        value: form.binNo,
        onChange: on('binNo'),
        mono: true,
      }),
      field('headOffice', 'Head office', {
        value: form.headOffice,
        onChange: on('headOffice'),
        wide: true,
      }),
      field('mobile', 'Mobile', { value: form.mobile, onChange: on('mobile'), mono: true }),
      field('email', 'Email', { value: form.email, onChange: on('email') }),
      field('currency', 'Currency', {
        value: form.currency,
        onChange: on('currency'),
        mono: true,
        hint: 'Three-letter code, as on a bank advice',
      }),
      // The districts the business already trades in, so the default is one of
      // them rather than a name nobody else uses.
      field('defaultDistrict', 'Default district', {
        options: districts,
        value: form.defaultDistrict,
        onChange: on('defaultDistrict'),
      }),
    ];
  }

  if (kind === 'fiscalYear') {
    return [
      field('code', 'Financial year', {
        value: form.code,
        onChange: on('code'),
        placeholder: 'FY 2027-28',
        wide: true,
      }),
      field('startsOn', 'Starts on', { type: 'date', value: form.startsOn, onChange: on('startsOn') }),
      field('endsOn', 'Ends on', { type: 'date', value: form.endsOn, onChange: on('endsOn') }),
      field('current', 'Make it the current year', {
        options: YES_NO,
        value: form.current,
        onChange: on('current'),
        hint: 'The year new documents are dated into',
      }),
    ];
  }

  if (kind === 'numbering') {
    const sample = `${(form.prefix || '?').toUpperCase()}-2608-${String(1).padStart(
      Math.max(1, Number(form.padding) || 1),
      '0'
    )}`;
    return [
      field('prefix', 'Prefix', {
        value: form.prefix,
        onChange: on('prefix'),
        mono: true,
        placeholder: 'PC',
        hint: '1–6 capitals or digits',
      }),
      field('padding', 'Digits', {
        type: 'number',
        value: form.padding,
        onChange: on('padding'),
        hint: `Numbers look like ${sample}`,
      }),
    ];
  }

  if (kind === 'limit') {
    const isPercent = row.condition === 'DISCOUNT_PCT_ABOVE';
    return [
      field('threshold', isPercent ? 'Ceiling (%)' : 'Requires approval above', {
        type: 'number',
        value: form.threshold,
        onChange: on('threshold'),
        hint: isPercent
          ? 'A discount above this goes to the approval queue'
          : 'A transaction above this goes to the approval queue',
        wide: true,
      }),
      field('active', 'Rule in force', {
        options: YES_NO,
        value: form.active,
        onChange: on('active'),
        hint: 'Switching it off lets these post without approval',
      }),
    ];
  }

  return [
    ...(row.threshold === null
      ? []
      : [
          field('threshold', row.unit === 'days' ? 'Days' : 'Amount', {
            type: 'number',
            value: form.threshold,
            onChange: on('threshold'),
            // The stored wording marks where its figure goes; in the form the
            // figure is the field itself.
            hint: String(row.description || '').replace('{value}', row.unit === 'days' ? 'this many' : 'this much'),
            wide: true,
          }),
        ]),
    field('active', 'Alert switched on', {
      options: YES_NO,
      value: form.active,
      onChange: on('active'),
    }),
  ];
}

/** The message to show instead of saving, or null when the form is good. */
export function validate(kind, form, row) {
  if (kind === 'company') {
    if (!String(form.name || '').trim()) return 'Enter the company name.';
    if (!String(form.systemName || '').trim()) return 'Enter the system name.';
    if (!/^[A-Za-z]{3}$/.test(String(form.currency || '').trim())) {
      return 'The currency is a three-letter code, like BDT.';
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(form.email).trim())) {
      return 'That email address does not look right.';
    }
    return null;
  }

  if (kind === 'fiscalYear') {
    if (!String(form.code || '').trim()) return 'Name the financial year, for example FY 2027-28.';
    if (!form.startsOn || !form.endsOn) return 'Give the day the year starts and the day it ends.';
    if (form.endsOn <= form.startsOn) return 'The year has to end after it starts.';
    return null;
  }

  if (kind === 'numbering') {
    if (!/^[A-Z][A-Z0-9]{0,5}$/.test(String(form.prefix || '').trim().toUpperCase())) {
      return 'A prefix is 1 to 6 capitals or digits, like PC.';
    }
    const padding = Number(form.padding);
    if (!Number.isInteger(padding) || padding < 1 || padding > 10) {
      return 'Use between 1 and 10 digits.';
    }
    return null;
  }

  if (kind === 'limit') {
    if (form.threshold === '' || form.threshold === null) return 'Give the limit this rule uses.';
    if (Number(form.threshold) < 0) return 'A limit cannot be negative.';
    if (row.condition === 'DISCOUNT_PCT_ABOVE' && Number(form.threshold) > 100) {
      return 'A discount ceiling above 100% would never be crossed.';
    }
    return null;
  }

  if (row.threshold !== null) {
    if (form.threshold === '' || form.threshold === null) return 'Give the value this alert fires on.';
    if (Number(form.threshold) < 0) return 'That cannot be negative.';
  }
  return null;
}

/** What goes to the repository. */
export function payloadFor(kind, form, row) {
  const text = (v) => String(v ?? '').trim();

  if (kind === 'company') {
    return {
      name: text(form.name),
      systemName: text(form.systemName),
      tradeLicenceNo: text(form.tradeLicenceNo),
      binNo: text(form.binNo),
      headOffice: text(form.headOffice),
      mobile: text(form.mobile),
      email: text(form.email),
      currency: text(form.currency).toUpperCase(),
      defaultDistrict: text(form.defaultDistrict),
    };
  }

  if (kind === 'fiscalYear') {
    return {
      code: text(form.code),
      startsOn: form.startsOn,
      endsOn: form.endsOn,
      current: form.current === 'yes',
    };
  }

  if (kind === 'numbering') {
    return { prefix: text(form.prefix).toUpperCase(), padding: Number(form.padding) };
  }

  if (kind === 'limit') {
    return { threshold: Number(form.threshold), active: form.active === 'yes' };
  }

  return {
    ...(row.threshold === null ? {} : { threshold: Number(form.threshold) }),
    active: form.active === 'yes',
  };
}

/** Build the modal model for a settings form. */
export function buildSettingsModal(kind, state, handlers, districts) {
  const { form, row, error, busy } = state;
  const [noun, blurb] = KINDS[kind];

  const titles = {
    company: 'Company profile',
    fiscalYear: 'New financial year',
    numbering: `${row.label} numbering`,
    limit: `${row.entityLabel} limit`,
    notification: row.name,
  };

  const subtitles = {
    company: blurb,
    fiscalYear: blurb,
    numbering: `Currently ${row.pattern}${row.issued ? ` · ${row.issued} issued this period` : ''}`,
    limit: blurb,
    notification: blurb,
  };

  return formModal({
    open: true,
    title: titles[kind],
    subtitle: subtitles[kind],
    fields: fieldsFor(kind, form, row, handlers.onField, districts),
    error,
    busy,
    submitLabel: kind === 'fiscalYear' ? `Add ${noun}` : 'Save changes',
    note:
      kind === 'numbering'
        ? 'Documents already issued keep the numbers they were given'
        : kind === 'company'
          ? 'Applies to documents produced from now on'
          : '',
    onSubmit: handlers.onSubmit,
    onCancel: handlers.onCancel,
  });
}
