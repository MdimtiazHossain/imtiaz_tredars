import { field, formModal, toggle } from '../components/formModal.js';

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
  role: ['role', 'A role is a set of permissions; people hold roles, not permissions'],
  grants: ['permissions', 'The server checks these on every request, not only this screen'],
  login: ['login', 'The person picks their own password when they first sign in'],
  roleAssign: ['roles', 'What this person may do, from the moment it is saved'],
  password: ['password', 'A reset signs the account out everywhere it is open'],
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
      vatRegistered: row.vatRegistered ? 'yes' : 'no',
      pricesIncludeTax: row.pricesIncludeTax ? 'yes' : 'no',
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

  if (kind === 'role') {
    // A code is what the rest of the system calls the role, so an existing one
    // never moves; a new one starts as the name, tidied.
    return { code: row.code || '', name: row.name || '', description: row.description || '' };
  }

  if (kind === 'grants') {
    // The codes inside this module the role already holds. The form works on
    // the set, and the payload sends the module as the scope, so nothing
    // outside it is touched by the save.
    return { granted: (row.granted || []).slice() };
  }

  if (kind === 'login') {
    return {
      // The select shows its first option whether or not the form holds one,
      // so the form holds it: otherwise it reads as chosen and saves as blank.
      employee: row.employee || (row.employeeOptions || [])[0] || '',
      username: row.username || '',
      email: '',
      password: '',
      roles: row.roles ? row.roles.slice() : [],
    };
  }

  if (kind === 'roleAssign') {
    return { roles: (row.roles || []).slice() };
  }

  if (kind === 'password') {
    return { password: '' };
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
        suggestions: districts,
        value: form.defaultDistrict,
        onChange: on('defaultDistrict'),
        placeholder: 'Bogura',
      }),
      field('vatRegistered', 'VAT registered', {
        options: [
          { value: 'no', label: 'No — nothing is charged' },
          { value: 'yes', label: 'Yes — every document charges its rate' },
        ],
        value: form.vatRegistered,
        onChange: on('vatRegistered'),
        hint: 'Turns VAT on across every posted document',
      }),
      field('pricesIncludeTax', 'Prices quoted', {
        options: [
          { value: 'no', label: 'Before VAT — tax is added on top' },
          { value: 'yes', label: 'Including VAT — tax is inside the rate' },
        ],
        value: form.pricesIncludeTax,
        onChange: on('pricesIncludeTax'),
        // Both are ordinary in Bangladesh: retail quotes what the customer
        // pays, business-to-business quotes the goods value.
        hint: 'How a rate on a document is read',
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

  if (kind === 'role') {
    return [
      field('name', 'Role name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'Branch manager',
        wide: true,
      }),
      // The code is fixed once anything refers to it -- a user holds it, the
      // sidebar prints it -- so an existing role shows it rather than offering
      // it. A new one is free to be named.
      field('code', 'Code', {
        value: form.code,
        onChange: on('code'),
        mono: true,
        placeholder: 'BranchManager',
        hint: row.id
          ? 'A role keeps the code it was created with'
          : 'What the rest of the system calls this role',
      }),
      field('description', 'What it is for', {
        value: form.description,
        onChange: on('description'),
        placeholder: 'Runs one branch: sells, collects, sees no profit',
        wide: true,
      }),
    ];
  }

  if (kind === 'login') {
    return [
      field('employee', 'Employee', {
        options: row.employeeOptions || [],
        value: form.employee,
        onChange: on('employee'),
        wide: true,
        hint: 'Only team members without a login are listed',
      }),
      field('username', 'Username', {
        value: form.username,
        onChange: on('username'),
        mono: true,
        hint: 'Lowercase letters, digits, dots, dashes',
      }),
      field('email', 'Email', { value: form.email, onChange: on('email') }),
      field('password', 'Temporary password', {
        type: 'password',
        value: form.password,
        onChange: on('password'),
        wide: true,
        hint: 'At least 10 characters. They are asked to change it at first sign-in.',
      }),
    ];
  }

  if (kind === 'password') {
    return [
      field('password', 'Temporary password', {
        type: 'password',
        value: form.password,
        onChange: on('password'),
        wide: true,
        hint: 'At least 10 characters. They are asked to change it at first sign-in.',
      }),
    ];
  }

  // Grants and role assignment are lists of switches rather than fields.
  if (kind === 'grants' || kind === 'roleAssign') return [];

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

  if (kind === 'role') {
    if (!String(form.name || '').trim()) return 'Give the role a name.';
    const code = String(form.code || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9 _-]{1,39}$/.test(code)) {
      return 'A code starts with a letter and uses letters, digits, spaces, dashes or underscores.';
    }
    return null;
  }

  if (kind === 'login') {
    if (!form.employee) return 'Choose the person this login belongs to.';
    if (!/^[a-z0-9._-]{3,40}$/.test(String(form.username || '').trim())) {
      return 'A username is 3 to 40 lowercase letters, digits, dots, dashes or underscores.';
    }
    if (String(form.password || '').length < 10) {
      return 'Choose a temporary password of at least 10 characters.';
    }
    if (!form.roles.length) return 'Give the login at least one role.';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(form.email).trim())) {
      return 'That email address does not look right.';
    }
    return null;
  }

  if (kind === 'password') {
    if (String(form.password || '').length < 10) {
      return 'Choose a temporary password of at least 10 characters.';
    }
    return null;
  }

  if (kind === 'roleAssign') {
    if (!form.roles.length) {
      return 'A login holds at least one role. Disable the account instead of leaving it with none.';
    }
    return null;
  }

  if (kind === 'grants') return null;

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
      vatRegistered: form.vatRegistered === 'yes',
      pricesIncludeTax: form.pricesIncludeTax === 'yes',
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

  if (kind === 'role') {
    return {
      code: text(form.code),
      name: text(form.name),
      description: text(form.description),
    };
  }

  if (kind === 'grants') {
    // The whole module is the scope; the granted set is what should survive.
    return {
      scope: (row.permissions || []).map((p) => p.code),
      permissions: form.granted.slice(),
    };
  }

  if (kind === 'login') {
    return {
      employeeId: row.employeeIds ? row.employeeIds[form.employee] : undefined,
      username: text(form.username).toLowerCase(),
      email: text(form.email),
      password: form.password,
      roles: form.roles.slice(),
    };
  }

  if (kind === 'roleAssign') {
    return { roles: form.roles.slice() };
  }

  if (kind === 'password') {
    return { password: form.password };
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
    role: row.id ? row.name : 'New role',
    grants: `${row.moduleLabel} · ${row.roleName}`,
    login: 'New login',
    roleAssign: row.name,
    password: `Reset password · ${row.name}`,
  };

  const subtitles = {
    company: blurb,
    fiscalYear: blurb,
    numbering: `Currently ${row.pattern}${row.issued ? ` · ${row.issued} issued this period` : ''}`,
    limit: blurb,
    notification: blurb,
    role: row.system
      ? 'One of the roles the system is set up around: it can be described and re-granted, not removed'
      : blurb,
    grants: `What ${row.roleName} may do with ${String(row.moduleLabel || '').toLowerCase()}`,
    login: blurb,
    roleAssign: `${row.designation || 'Team member'} · signs in as ${row.username}`,
    password: blurb,
  };

  const submitLabels = {
    fiscalYear: `Add ${noun}`,
    role: row.id ? 'Save changes' : 'Add role',
    login: 'Create login',
    password: 'Reset password',
  };

  const notes = {
    numbering: 'Documents already issued keep the numbers they were given',
    company: 'Applies to documents produced from now on',
    grants: 'Takes effect immediately, including for anyone already signed in',
    roleAssign: 'Takes effect immediately, including if they are signed in now',
    password: 'Every session on this account is signed out',
  };

  return formModal({
    open: true,
    title: titles[kind],
    subtitle: subtitles[kind],
    fields: fieldsFor(kind, form, row, handlers.onField, districts),
    toggles: togglesFor(kind, form, row, handlers.onToggle),
    error,
    busy,
    submitLabel: submitLabels[kind] || 'Save changes',
    note: notes[kind] || '',
    onSubmit: handlers.onSubmit,
    onCancel: handlers.onCancel,
  });
}

/**
 * The switch list a form shows, where it has one.
 *
 * Permissions and role assignment are both "which of these does it hold",
 * which is a list of switches rather than a grid of fields -- and the same
 * control the Settings panels already use for units and payment methods.
 */
export function togglesFor(kind, form, row, onToggle) {
  if (kind === 'grants') {
    return {
      title: `${row.moduleLabel} permissions`,
      note: `${form.granted.length} of ${(row.permissions || []).length} granted`,
      rows: (row.permissions || []).map((permission) =>
        toggle({
          key: permission.code,
          label: permission.label,
          description: permission.description || permission.code,
          on: form.granted.includes(permission.code),
          onToggle: () => onToggle('granted', permission.code),
        })
      ),
    };
  }

  if (kind === 'roleAssign' || kind === 'login') {
    return {
      title: 'Roles',
      note: form.roles.length
        ? form.roles.join(', ')
        : 'None yet — a login needs at least one',
      rows: (row.roleOptions || []).map((role) =>
        toggle({
          key: role.code,
          label: role.name,
          description: role.description || `${role.granted.length} permissions`,
          on: form.roles.includes(role.code),
          onToggle: () => onToggle('roles', role.code),
        })
      ),
    };
  }

  return null;
}
